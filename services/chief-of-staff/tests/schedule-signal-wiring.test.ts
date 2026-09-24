import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { osloLocalToDate } from "../lib/recurrence.js";
import { closePool } from "@lares/agent-kit/db";

/**
 * Task 3 (final-review Fix 3) — every schedule's error path must reach `emitSignal`, not just
 * a `console.error`. `lib/signal-emit.ts` itself was already fully tested
 * (`tests/signal-emit.test.ts`) — this file proves the WIRING: that each of the 7 schedules'
 * `run()` actually calls it when the tick fails, not merely that `emitSignal` works in
 * isolation.
 *
 * One shared mechanism drives every case: `DATABASE_URL` is set to a syntactically valid but
 * unreachable connection string (loopback, port 1 — refuses instantly, no real Postgres
 * needed). `pg.Pool` never validates connectivity at construction, so the schedule's own code
 * runs exactly as it would in production right up to the first real query, which then rejects
 * with ECONNREFUSED — driving the same catch block a real outage would.
 *
 * Each test freshly re-imports its schedule module (`vi.resetModules()` in `beforeEach`) so
 * module-scope state (`lastSlot`, `running`, `liveState`, `tablesEnsured`, the `lib/db.ts`
 * pool singleton) never leaks between cases — `vi.mock` registrations survive `resetModules`,
 * so the `emitSignal` spy stays wired across every fresh import.
 */

const emitSignalMock = vi.fn(async () => {});
vi.mock("../lib/signal-emit.js", () => ({ emitSignal: emitSignalMock }));

const UNREACHABLE_DB = "postgres://baduser:badpass@127.0.0.1:1/eve_test_signal_wiring";

const ENV_KEYS = [
  "EVE_SCHEDULES_LIVE",
  "DATABASE_URL",
  "TELEGRAM_PRINCIPAL_ID",
  "SLACK_ALLOWED_USER_IDS",
  "OBLIGATION_REPING_ENABLED",
];
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  emitSignalMock.mockClear();
  await closePool().catch(() => {});
  vi.resetModules();
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
  await closePool().catch(() => {});
});

const CTX = { to: (() => {}) as never, waitUntil: (() => {}) as never, appAuth: {} as never };

describe("schedule error paths reach the signal spine (Fix 3)", () => {
  it("reminders: a failing store call is caught by the outer catch and signaled", async () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["DATABASE_URL"] = UNREACHABLE_DB;

    const { default: schedule } = await import("../agent/schedules/reminders.js");
    await expect(schedule.run!(CTX)).resolves.toBeUndefined();

    expect(emitSignalMock).toHaveBeenCalledWith(
      "schedule-tick-failed",
      expect.stringContaining("reminders"),
      expect.any(String),
    );
  }, 20_000);

  it("proposals-watch: a failing notion-lane query is caught and signaled", async () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["DATABASE_URL"] = UNREACHABLE_DB;
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { default: schedule } = await import("../agent/schedules/proposals-watch.js");
    await expect(schedule.run!(CTX)).resolves.toBeUndefined();

    expect(emitSignalMock).toHaveBeenCalledWith(
      "schedule-tick-failed",
      expect.stringContaining("proposals-watch"),
      expect.any(String),
    );
  }, 20_000);

  it("evening-brief: a failing obligations-table query at the 20:00 Oslo slot is caught and signaled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(osloLocalToDate("2026-06-17 20:00")); // 2026-06-17 is a Wednesday
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["DATABASE_URL"] = UNREACHABLE_DB;
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { default: schedule } = await import("../agent/schedules/evening-brief.js");
    await expect(schedule.run!(CTX)).resolves.toBeUndefined();

    expect(emitSignalMock).toHaveBeenCalledWith(
      "schedule-tick-failed",
      expect.stringContaining("evening-brief"),
      expect.any(String),
    );
  }, 20_000);

  it("morning-brief: a failing obligations query at the 08:00 Oslo slot is caught and signaled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(osloLocalToDate("2026-06-17 08:00"));
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["DATABASE_URL"] = UNREACHABLE_DB;
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { default: schedule } = await import("../agent/schedules/morning-brief.js");
    await expect(schedule.run!(CTX)).resolves.toBeUndefined();

    expect(emitSignalMock).toHaveBeenCalledWith(
      "schedule-tick-failed",
      expect.stringContaining("morning-brief"),
      expect.any(String),
    );
  }, 20_000);

  it("reping: a failing obligations-table query is caught and signaled", async () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["OBLIGATION_REPING_ENABLED"] = "1";
    process.env["DATABASE_URL"] = UNREACHABLE_DB;
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { default: schedule } = await import("../agent/schedules/reping.js");
    await expect(schedule.run!(CTX)).resolves.toBeUndefined();

    expect(emitSignalMock).toHaveBeenCalledWith(
      "schedule-tick-failed",
      expect.stringContaining("reping"),
      expect.any(String),
    );
  }, 20_000);

  it("weekly-summary: a failing activePreferences query at the Sunday 09:00 Oslo slot is caught and signaled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(osloLocalToDate("2026-06-21 09:00")); // 2026-06-21 is a Sunday
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["DATABASE_URL"] = UNREACHABLE_DB;
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456";

    const { default: schedule } = await import("../agent/schedules/weekly-summary.js");
    await expect(schedule.run!(CTX)).resolves.toBeUndefined();

    expect(emitSignalMock).toHaveBeenCalledWith(
      "schedule-tick-failed",
      expect.stringContaining("weekly-summary"),
      expect.any(String),
    );
  }, 20_000);

  it("crm-routing: a failing ensureRouteTables query at a route-hour Oslo slot is caught and signaled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(osloLocalToDate("2026-06-17 09:00"));
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["DATABASE_URL"] = UNREACHABLE_DB;
    process.env["SLACK_ALLOWED_USER_IDS"] = "U123456";

    const { default: schedule } = await import("../agent/schedules/crm-routing.js");
    await expect(schedule.run!(CTX)).resolves.toBeUndefined();

    expect(emitSignalMock).toHaveBeenCalledWith(
      "schedule-tick-failed",
      expect.stringContaining("crm-routing"),
      expect.any(String),
    );
  }, 20_000);
});
