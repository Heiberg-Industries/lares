import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ENGINE,
  decideInitiation,
  isWithinQuietHours,
  instantAt,
  nextOwnerDayStart,
  nextQuietEnd,
  loadSettings,
  loadLedgerState,
  gateInitiation,
  gatedSend,
  wouldSend,
  deferredSince,
  type InitiationRequest,
  type ProactivitySettings,
  type LedgerState,
} from "../src/proactivity.js";

/**
 * ORB-193. The gate every proactive message passes.
 *
 * The pure rules are unit-tested; everything that touches the ledger is proven against a REAL
 * Postgres and the REAL migrations (031 then 035 — 035 seeds a heartbeat row, so 031's table must
 * exist first). A fake pool that never executes SQL is the "built + tested + non-functional" class
 * this project has already paid for (ORB-45), and running the migration here is the only place it
 * is exercised before the box.
 */

const base: InitiationRequest = { owner: "bendik", agent: "saga", door: "telegram:1", cls: "event", itemKey: "msg-1", now: new Date("2026-09-08T10:00:00Z"), tz: "Europe/Oslo" };
const defaults: ProactivitySettings = { quietStart: "21:00", quietEnd: "07:00", eventPerDoorPerDay: 10, escalationPerDoorPerDay: 3, perOwnerPerDay: 15, dnd: false };
const fresh: LedgerState = { sentTodayDoorEvent: 0, sentTodayDoorEscalation: 0, sentTodayOwner: 0, alreadySeen: false };

describe("decideInitiation (pure rules)", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("today's fleet under the defaults: every class sends in daylight", () => {
    for (const cls of ["scheduled", "event", "escalation"] as const)
      expect(decideInitiation({ ...base, cls }, defaults, fresh)).toEqual({ verdict: "send" });
  });

  it("DND suppresses everything except a final stop, which defers to the next owner day", () => {
    expect(decideInitiation(base, { ...defaults, dnd: true }, fresh)).toEqual({ verdict: "suppress", reason: "dnd" });
    const d = decideInitiation({ ...base, finalStop: true }, { ...defaults, dnd: true }, fresh);
    expect(d.verdict).toBe("defer"); expect((d as any).reason).toBe("dnd-final-stop");
    expect((d as any).until).toBe("2026-09-08T22:00:00.000Z"); // next Oslo midnight
  });

  it("already-seen wins over quiet hours and ceilings", () => {
    expect(decideInitiation(base, defaults, { ...fresh, alreadySeen: true })).toEqual({ verdict: "suppress", reason: "already-seen" });
    const night = new Date("2026-09-08T20:30:00Z");
    expect(decideInitiation({ ...base, now: night }, defaults, { sentTodayDoorEvent: 99, sentTodayDoorEscalation: 99, sentTodayOwner: 99, alreadySeen: true }))
      .toEqual({ verdict: "suppress", reason: "already-seen" });
  });

  it("DND wins over already-seen (the switch is checked first)", () => {
    expect(decideInitiation(base, { ...defaults, dnd: true }, { ...fresh, alreadySeen: true }))
      .toEqual({ verdict: "suppress", reason: "dnd" });
  });

  it("quiet hours: a scheduled slot is dropped for good; an event is deferred to quiet end; an owner-set reminder passes", () => {
    const night = new Date("2026-09-08T20:30:00Z"); // 22:30 Oslo (CEST)
    expect(decideInitiation({ ...base, cls: "scheduled", itemKey: "brief/2026-09-08T22", now: night }, defaults, fresh)).toEqual({ verdict: "suppress", reason: "quiet-hours" });
    const d = decideInitiation({ ...base, now: night }, defaults, fresh);
    expect(d).toMatchObject({ verdict: "defer", reason: "quiet-hours", until: "2026-09-09T05:00:00.000Z" }); // 07:00 Oslo
    expect(decideInitiation({ ...base, now: night, ownerSetTime: true }, defaults, fresh)).toEqual({ verdict: "send" });
  });

  it("a quiet-hours defer past midnight rolls to the NEXT slot (quiet end), not to the next owner day", () => {
    const late = new Date("2026-09-08T21:30:00Z"); // 23:30 Oslo
    expect(decideInitiation({ ...base, now: late }, defaults, fresh))
      .toMatchObject({ verdict: "defer", reason: "quiet-hours", until: "2026-09-09T05:00:00.000Z" });
    const small = new Date("2026-09-08T23:30:00Z"); // 01:30 Oslo on the 9th
    expect(decideInitiation({ ...base, now: small }, defaults, fresh))
      .toMatchObject({ verdict: "defer", reason: "quiet-hours", until: "2026-09-09T05:00:00.000Z" });
  });

  it("quiet-hours boundaries wrap midnight: 21:00 is quiet, 06:59 is quiet, 07:00 is not, 20:59 is not", () => {
    expect(isWithinQuietHours("21:00", "21:00", "07:00")).toBe(true);
    expect(isWithinQuietHours("06:59", "21:00", "07:00")).toBe(true);
    expect(isWithinQuietHours("07:00", "21:00", "07:00")).toBe(false);
    expect(isWithinQuietHours("20:59", "21:00", "07:00")).toBe(false);
  });

  it("quiet hours also work without a midnight wrap (a daytime window)", () => {
    expect(isWithinQuietHours("10:00", "09:00", "17:00")).toBe(true);
    expect(isWithinQuietHours("17:00", "09:00", "17:00")).toBe(false);
    expect(isWithinQuietHours("08:59", "09:00", "17:00")).toBe(false);
  });

  it("ceilings: the 11th event on a door defers to the next owner day; the 4th escalation too; the 16th of any kind for the owner", () => {
    expect(decideInitiation(base, defaults, { ...fresh, sentTodayDoorEvent: 10 })).toMatchObject({ verdict: "defer", reason: "door-ceiling", until: "2026-09-08T22:00:00.000Z" });
    expect(decideInitiation({ ...base, cls: "escalation" }, defaults, { ...fresh, sentTodayDoorEscalation: 3 })).toMatchObject({ verdict: "defer", reason: "door-ceiling" });
    expect(decideInitiation(base, defaults, { ...fresh, sentTodayOwner: 15 })).toMatchObject({ verdict: "defer", reason: "owner-ceiling" });
    expect(decideInitiation({ ...base, cls: "scheduled", itemKey: "digest/x" }, defaults, { ...fresh, sentTodayDoorEvent: 10, sentTodayDoorEscalation: 3, sentTodayOwner: 15 })).toEqual({ verdict: "send" });
  });

  it("the two door budgets are separate: a chatty day of events never spends the escalation budget", () => {
    // 10 events sent on this door: the 11th event is held, but an escalation — the class that
    // exists for the item nothing has answered — still gets through.
    const eventsSpent: LedgerState = { ...fresh, sentTodayDoorEvent: 10, sentTodayOwner: 10 };
    expect(decideInitiation(base, defaults, eventsSpent)).toMatchObject({ verdict: "defer", reason: "door-ceiling" });
    expect(decideInitiation({ ...base, cls: "escalation" }, defaults, eventsSpent)).toEqual({ verdict: "send" });
    // And the mirror: 3 escalations spent holds the 4th escalation, not the next event.
    const escalationsSpent: LedgerState = { ...fresh, sentTodayDoorEscalation: 3, sentTodayOwner: 3 };
    expect(decideInitiation({ ...base, cls: "escalation" }, defaults, escalationsSpent)).toMatchObject({ verdict: "defer", reason: "door-ceiling" });
    expect(decideInitiation(base, defaults, escalationsSpent)).toEqual({ verdict: "send" });
  });

  it("the owner ceiling spans both classes and holds everything non-scheduled", () => {
    const spent: LedgerState = { ...fresh, sentTodayDoorEvent: 8, sentTodayDoorEscalation: 2, sentTodayOwner: 15 };
    expect(decideInitiation(base, defaults, spent)).toMatchObject({ verdict: "defer", reason: "owner-ceiling" });
    expect(decideInitiation({ ...base, cls: "escalation" }, defaults, spent)).toMatchObject({ verdict: "defer", reason: "owner-ceiling" });
    expect(decideInitiation({ ...base, cls: "scheduled", itemKey: "brief/x" }, defaults, spent)).toEqual({ verdict: "send" });
  });

  it("the 10th event still sends — the ceiling is a count of what already went out", () => {
    expect(decideInitiation(base, defaults, { ...fresh, sentTodayDoorEvent: 9, sentTodayOwner: 14 })).toEqual({ verdict: "send" });
  });

  it("a lowered ceiling of 0 stops the class entirely", () => {
    expect(decideInitiation(base, { ...defaults, eventPerDoorPerDay: 0 }, fresh))
      .toMatchObject({ verdict: "defer", reason: "door-ceiling" });
  });

  it("the engine defaults are the accepted six", () => {
    expect(ENGINE).toEqual({ quietStart: "21:00", quietEnd: "07:00", quietMinHours: 8, eventPerDoorPerDay: 20, escalationPerDoorPerDay: 3, perOwnerPerDay: 30 });
  });

  it("an unparseable quiet window falls back to the ENGINE window, never to 'no quiet hours'", () => {
    // A malformed cell used to reach `toMinutes` as NaN, and every comparison against NaN is false —
    // so one typo abolished quiet hours at every hour of the day, silently.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(isWithinQuietHours("22:30", "7am", "07:00")).toBe(true);
    expect(isWithinQuietHours("12:00", "21:00", "07.00")).toBe(false);
    expect(isWithinQuietHours("03:00", "9pm", "7am")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/21:00–07:00/);

    // The property that matters: no window, however malformed, reads as quiet-at-no-hour.
    const quietHours = Array.from({ length: 24 }, (_, h) => isWithinQuietHours(`${String(h).padStart(2, "0")}:00`, "oops", "nonsense"));
    expect(quietHours.filter(Boolean)).toHaveLength(10); // 21, 22, 23, 00 … 06
  });

  it("a malformed wall clock is read as outside quiet hours, with a warning (only reachable by hand)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(isWithinQuietHours("half past ten", "21:00", "07:00")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("DST: the 25-hour day of 2026-10-25 in Europe/Oslo", () => {
    const tz = "Europe/Oslo";
    // Midnight starting the 25th is CEST (+02:00); midnight starting the 26th is CET (+01:00).
    expect(nextOwnerDayStart(new Date("2026-10-24T12:00:00Z"), tz).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(nextOwnerDayStart(new Date("2026-10-25T12:00:00Z"), tz).toISOString()).toBe("2026-10-25T23:00:00.000Z");
    // A quiet-hours hold taken at 23:30 CEST on the 24th ends at 07:00 CET on the 25th — nine wall
    // hours later, because the clocks went back inside the hold.
    expect(nextQuietEnd(new Date("2026-10-24T21:30:00Z"), tz, "07:00").toISOString()).toBe("2026-10-25T06:00:00.000Z");
  });

  it("a wall clock inside the spring-forward gap resolves to the instant BEFORE it (documented, not desired)", () => {
    // 02:30 never happens on 2026-03-29 in Oslo; the search cannot converge and stops early rather
    // than late. Pinned so a change to the correction loop is visible.
    expect(instantAt("2026-03-29", "02:30", "Europe/Oslo").toISOString()).toBe("2026-03-29T00:30:00.000Z");
  });

  it("the owner clock is the request's tz, not the box's: 10:00 UTC is quiet in Auckland", () => {
    // 2026-09-08T10:00Z = 22:00 Pacific/Auckland (NZST) — inside 21:00–07:00.
    expect(decideInitiation({ ...base, tz: "Pacific/Auckland" }, defaults, fresh))
      .toMatchObject({ verdict: "defer", reason: "quiet-hours" });
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const sql = (name: string) => readFileSync(join(here, "..", "..", "..", "services", "box", "sql", name), "utf8");

describe("the ledger, against a real Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(sql("031_schedule_heartbeat.sql")); // 035 seeds a heartbeat row
    await pool.query(sql("035_proactivity.sql"));
  }, 180_000);

  afterAll(async () => { await pool.end(); await container.stop(); });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await pool.query("delete from initiations");
    await pool.query("delete from proactivity_settings");
  });

  it("the migration is idempotent and ships the owner-clock heartbeat row", async () => {
    await pool.query(sql("035_proactivity.sql"));
    const { rows } = await pool.query("select agent from heartbeat where agent = 'saga/owner-clock'");
    expect(rows).toHaveLength(1);
  });

  describe("loadSettings", () => {
    it("no rows → the engine defaults", async () => {
      // `defaults` above is the decideInitiation fixture (its own numbers); the engine is 20/3/30.
      expect(await loadSettings(pool, "bendik", "saga", "telegram:1")).toEqual({ ...defaults, eventPerDoorPerDay: 20, perOwnerPerDay: 30 });
    });

    it("a global row dnd=true → DND for every agent and every door", async () => {
      await pool.query("insert into proactivity_settings (owner, dnd) values ('bendik', true)");
      expect((await loadSettings(pool, "bendik", "saga", "telegram:1")).dnd).toBe(true);
      expect((await loadSettings(pool, "bendik", "marcel", "telegram:9")).dnd).toBe(true);
      expect((await loadSettings(pool, "someone-else", "saga", "telegram:1")).dnd).toBe(false);
    });

    it("an agent row dnd=false does NOT override a global true — DND is OR across scopes", async () => {
      await pool.query("insert into proactivity_settings (owner, dnd) values ('bendik', true)");
      await pool.query("insert into proactivity_settings (owner, agent, dnd) values ('bendik', 'saga', false)");
      expect((await loadSettings(pool, "bendik", "saga", "telegram:1")).dnd).toBe(true);
    });

    it("an agent row alone switches DND on for that agent only", async () => {
      await pool.query("insert into proactivity_settings (owner, agent, dnd) values ('bendik', 'saga', true)");
      expect((await loadSettings(pool, "bendik", "saga", "telegram:1")).dnd).toBe(true);
      expect((await loadSettings(pool, "bendik", "marcel", "telegram:1")).dnd).toBe(false);
    });

    it("a door row lowers the event ceiling to 4", async () => {
      await pool.query("insert into proactivity_settings (owner, agent, door, event_per_door_per_day) values ('bendik', 'saga', 'telegram:1', 4)");
      expect((await loadSettings(pool, "bendik", "saga", "telegram:1")).eventPerDoorPerDay).toBe(4);
      expect((await loadSettings(pool, "bendik", "saga", "telegram:2")).eventPerDoorPerDay).toBe(20);
    });

    it("a ceiling ABOVE the engine default is clamped down, never honoured", async () => {
      await pool.query("insert into proactivity_settings (owner, event_per_door_per_day, escalation_per_door_per_day, per_owner_per_day) values ('bendik', 50, 99, 400)");
      const s = await loadSettings(pool, "bendik", "saga", "telegram:1");
      expect(s.eventPerDoorPerDay).toBe(20);
      expect(s.escalationPerDoorPerDay).toBe(3);
      expect(s.perOwnerPerDay).toBe(30);
    });

    it("quiet_start comes from the most specific row: global → agent → door", async () => {
      await pool.query("insert into proactivity_settings (owner, quiet_start) values ('bendik', '20:00')");
      expect((await loadSettings(pool, "bendik", "saga", "telegram:1")).quietStart).toBe("20:00");
      await pool.query("insert into proactivity_settings (owner, agent, quiet_start) values ('bendik', 'saga', '19:00')");
      expect((await loadSettings(pool, "bendik", "saga", "telegram:1")).quietStart).toBe("19:00");
      await pool.query("insert into proactivity_settings (owner, agent, door, quiet_start) values ('bendik', 'saga', 'telegram:1', '18:00')");
      const s = await loadSettings(pool, "bendik", "saga", "telegram:1");
      expect(s.quietStart).toBe("18:00");
      expect(s.quietEnd).toBe("07:00"); // untouched fields keep the engine default
    });

    it("a window shorter than the engine floor falls back to the ENGINE window whole", async () => {
      // NOT 23:00 + 8 h. Widening the end would turn 05:00–06:00 into 05:00–13:00 and silence the
      // whole morning — the opposite of what someone typing a one-hour window asked for.
      await pool.query("insert into proactivity_settings (owner, quiet_start, quiet_end) values ('bendik', '23:00', '01:00')");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const s = await loadSettings(pool, "bendik", "saga", "telegram:1");
      expect([s.quietStart, s.quietEnd]).toEqual(["21:00", "07:00"]);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/8 h/);
    });

    it("the table REFUSES a malformed quiet value — the CHECK is the first line of defence", async () => {
      await expect(pool.query("insert into proactivity_settings (owner, quiet_start) values ('bendik', '7am')"))
        .rejects.toThrow(/quiet_start/);
      await expect(pool.query("insert into proactivity_settings (owner, quiet_end) values ('bendik', '07.00')"))
        .rejects.toThrow(/quiet_end/);
      await expect(pool.query("insert into proactivity_settings (owner, quiet_start) values ('bendik', '24:00')"))
        .rejects.toThrow(/quiet_start/);
    });

    it("and if the CHECK were ever absent, the read still falls back per cell, naming the row", async () => {
      // Simulates a table that predates the constraint. Both layers are needed: the constraint stops
      // the value being stored, this stops a stored one abolishing quiet hours.
      await pool.query("alter table proactivity_settings drop constraint proactivity_settings_quiet_start_check");
      await pool.query("alter table proactivity_settings drop constraint proactivity_settings_quiet_end_check");
      try {
        await pool.query("insert into proactivity_settings (owner, quiet_start, quiet_end) values ('bendik', '7am', '07.00')");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const s = await loadSettings(pool, "bendik", "saga", "telegram:1");
        expect([s.quietStart, s.quietEnd]).toEqual(["21:00", "07:00"]);
        const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
        for (const fragment of ["quiet_start", '"7am"', "quiet_end", '"07.00"', "bendik/saga/telegram:1"]) {
          expect(said).toContain(fragment);
        }
      } finally {
        await pool.query("delete from proactivity_settings");
        await pool.query("alter table proactivity_settings add constraint proactivity_settings_quiet_start_check check (quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')");
        await pool.query("alter table proactivity_settings add constraint proactivity_settings_quiet_end_check check (quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')");
      }
    });

    it("a legal owner window is honoured whole", async () => {
      await pool.query("insert into proactivity_settings (owner, quiet_start, quiet_end) values ('bendik', '22:00', '08:00')");
      const s = await loadSettings(pool, "bendik", "saga", "telegram:1");
      expect([s.quietStart, s.quietEnd]).toEqual(["22:00", "08:00"]);
    });
  });

  describe("gateInitiation", () => {
    it("a send decision writes NOTHING until confirm() — a row before the send would drop the item for good", async () => {
      const d = await gateInitiation(pool, base);
      expect(d.verdict).toBe("send");
      expect((await pool.query("select * from initiations")).rows).toHaveLength(0);
      await d.confirm();
      const { rows } = await pool.query("select *, owner_day::text as day from initiations");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ owner: "bendik", agent: "saga", door: "telegram:1", cls: "event", item_key: "msg-1", status: "sent", reason: null, day: "2026-09-08" });
      expect(rows[0].sent_at).not.toBeNull();
    });

    it("after confirm() the same item is already-seen", async () => {
      const first = await gateInitiation(pool, base);
      await first.confirm();
      const second = await gateInitiation(pool, base);
      expect(second.verdict).toBe("suppress");
      expect((second as any).reason).toBe("already-seen");
    });

    it("already-seen is per (owner, agent, itemKey) — another agent's key is its own", async () => {
      const first = await gateInitiation(pool, base);
      await first.confirm();
      expect((await gateInitiation(pool, { ...base, agent: "marcel" })).verdict).toBe("send");
      expect((await gateInitiation(pool, { ...base, itemKey: "msg-2" })).verdict).toBe("send");
    });

    it("already-seen survives the day boundary — a sent row from last week still suppresses", async () => {
      const first = await gateInitiation(pool, { ...base, now: new Date("2026-09-01T10:00:00Z") });
      await first.confirm();
      expect((await gateInitiation(pool, base)).verdict).toBe("suppress");
    });

    it("confirm() is idempotent — a second call writes no second row", async () => {
      const d = await gateInitiation(pool, base);
      await d.confirm();
      await d.confirm();
      expect((await pool.query("select * from initiations")).rows).toHaveLength(1);
    });

    it("a suppression writes its row immediately, with the reason", async () => {
      await pool.query("insert into proactivity_settings (owner, dnd) values ('bendik', true)");
      const d = await gateInitiation(pool, base);
      expect(d).toMatchObject({ verdict: "suppress", reason: "dnd" });
      const { rows } = await pool.query("select * from initiations");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "suppressed", reason: "dnd", sent_at: null, until_at: null });
    });

    it("a deferral writes its row immediately, with the reason and the instant it may return", async () => {
      const d = await gateInitiation(pool, { ...base, now: new Date("2026-09-08T20:30:00Z") });
      expect(d).toMatchObject({ verdict: "defer", reason: "quiet-hours" });
      const { rows } = await pool.query("select * from initiations");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "deferred", reason: "quiet-hours", sent_at: null });
      expect((rows[0].until_at as Date).toISOString()).toBe("2026-09-09T05:00:00.000Z");
    });

    it("confirm() on a suppressed decision writes no sent row", async () => {
      await pool.query("insert into proactivity_settings (owner, dnd) values ('bendik', true)");
      const d = await gateInitiation(pool, base);
      await d.confirm();
      const { rows } = await pool.query("select status from initiations");
      expect(rows.map((r) => r.status)).toEqual(["suppressed"]);
    });
  });

  describe("the daily counters are counted on the OWNER clock", () => {
    // 2026-09-08T21:30Z = 23:30 Oslo on the 8th; 2026-09-08T22:30Z = 00:30 Oslo on the 9th.
    const yesterdayLate = new Date("2026-09-08T21:30:00Z");
    const todayEarly = new Date("2026-09-08T22:30:00Z");
    const today = new Date("2026-09-09T08:00:00Z");

    const send = async (req: Partial<InitiationRequest>) => {
      const d = await gateInitiation(pool, { ...base, ownerSetTime: true, ...req });
      await d.confirm();
      return d;
    };

    it("a row at 23:30 Oslo yesterday does not count today; a row at 00:30 Oslo today does", async () => {
      await send({ itemKey: "a", now: yesterdayLate });
      expect(await loadLedgerState(pool, { ...base, now: today, itemKey: "z" })).toMatchObject({ sentTodayDoorEvent: 0, sentTodayDoorEscalation: 0, sentTodayOwner: 0 });
      await send({ itemKey: "b", now: todayEarly });
      expect(await loadLedgerState(pool, { ...base, now: today, itemKey: "z" })).toMatchObject({ sentTodayDoorEvent: 1, sentTodayOwner: 1 });
    });

    it("only sent event+escalation rows count — scheduled slots and suppressions never do", async () => {
      await send({ itemKey: "s1", cls: "scheduled", now: todayEarly });
      await pool.query("insert into proactivity_settings (owner, dnd) values ('bendik', true)");
      const suppressed = await gateInitiation(pool, { ...base, itemKey: "s2", now: todayEarly });
      expect(suppressed.verdict).toBe("suppress");
      await pool.query("delete from proactivity_settings");
      await send({ itemKey: "e1", cls: "escalation", now: todayEarly });
      expect(await loadLedgerState(pool, { ...base, now: today, itemKey: "z" }))
        .toMatchObject({ sentTodayDoorEvent: 0, sentTodayDoorEscalation: 1, sentTodayOwner: 1 });
    });

    it("the door count is per door; the owner count is across doors and agents", async () => {
      await send({ itemKey: "d1", door: "telegram:1", now: todayEarly });
      await send({ itemKey: "d2", door: "slack:C1", now: todayEarly });
      await send({ itemKey: "d3", door: "slack:C1", agent: "marcel", now: todayEarly });
      expect(await loadLedgerState(pool, { ...base, door: "telegram:1", now: today, itemKey: "z" })).toMatchObject({ sentTodayDoorEvent: 1, sentTodayOwner: 3 });
      expect(await loadLedgerState(pool, { ...base, door: "slack:C1", now: today, itemKey: "z" })).toMatchObject({ sentTodayDoorEvent: 2, sentTodayOwner: 3 });
    });

    it("the two door budgets are counted apart in the ledger too", async () => {
      await pool.query("insert into proactivity_settings (owner, event_per_door_per_day, escalation_per_door_per_day) values ('bendik', 1, 1)");
      await send({ itemKey: "ev", now: todayEarly });
      expect(await loadLedgerState(pool, { ...base, now: today, itemKey: "z" }))
        .toMatchObject({ sentTodayDoorEvent: 1, sentTodayDoorEscalation: 0 });
      // The event budget is spent; the escalation budget is untouched.
      expect(await gateInitiation(pool, { ...base, itemKey: "ev2", now: today }))
        .toMatchObject({ verdict: "defer", reason: "door-ceiling" });
      expect((await gateInitiation(pool, { ...base, cls: "escalation", itemKey: "esc", now: today })).verdict).toBe("send");
    });

    it("the ceiling bites on the owner day, not on a rolling 24 h", async () => {
      await pool.query("insert into proactivity_settings (owner, event_per_door_per_day) values ('bendik', 1)");
      await send({ itemKey: "late", now: yesterdayLate });
      // One hour later in real time, but a new owner day: the ceiling is clear again.
      expect((await gateInitiation(pool, { ...base, itemKey: "early", now: todayEarly, ownerSetTime: true })).verdict).toBe("send");
      const d = await send({ itemKey: "early", now: todayEarly });
      expect(d.verdict).toBe("send");
      expect(await gateInitiation(pool, { ...base, itemKey: "third", now: today }))
        .toMatchObject({ verdict: "defer", reason: "door-ceiling" });
    });
  });

  describe("an open deferral is reused, never re-written", () => {
    const night = new Date("2026-09-08T20:30:00Z");   // 22:30 Oslo — quiet
    const aMinuteLater = new Date("2026-09-08T20:31:00Z");
    const afterQuietEnd = new Date("2026-09-09T06:00:00Z"); // 08:00 Oslo, past the 07:00 hold

    it("a poller re-asking about a held item costs one row per HOLD, not one per tick", async () => {
      const first = await gateInitiation(pool, { ...base, now: night });
      expect(first).toMatchObject({ verdict: "defer", reason: "quiet-hours", until: "2026-09-09T05:00:00.000Z" });
      const second = await gateInitiation(pool, { ...base, now: aMinuteLater });
      expect(second).toMatchObject({ verdict: "defer", reason: "quiet-hours", until: "2026-09-09T05:00:00.000Z" });
      const { rows } = await pool.query("select status, reason from initiations");
      expect(rows).toEqual([{ status: "deferred", reason: "quiet-hours" }]);
    });

    it("once the hold expires the item is decided afresh — and then it sends", async () => {
      await gateInitiation(pool, { ...base, now: night });
      const d = await gateInitiation(pool, { ...base, now: afterQuietEnd });
      expect(d.verdict).toBe("send");
      await d.confirm();
      const { rows } = await pool.query("select status from initiations order by id");
      expect(rows.map((r) => r.status)).toEqual(["deferred", "sent"]);
    });

    it("the hold is per (owner, agent, itemKey) — another item is decided on its own merits", async () => {
      await gateInitiation(pool, { ...base, now: night });
      const other = await gateInitiation(pool, { ...base, itemKey: "msg-2", now: aMinuteLater });
      expect(other).toMatchObject({ verdict: "defer", reason: "quiet-hours" });
      expect((await pool.query("select item_key from initiations order by item_key")).rows)
        .toEqual([{ item_key: "msg-1" }, { item_key: "msg-2" }]);
    });

    it("a ceiling hold expires with the owner day, and the fresh decision sends", async () => {
      await pool.query("insert into proactivity_settings (owner, event_per_door_per_day) values ('bendik', 0)");
      const held = await gateInitiation(pool, base);
      expect(held).toMatchObject({ verdict: "defer", reason: "door-ceiling", until: "2026-09-08T22:00:00.000Z" });
      await gateInitiation(pool, { ...base, now: new Date("2026-09-08T12:00:00Z") });
      expect((await pool.query("select count(*)::int as n from initiations")).rows[0].n).toBe(1);
      await pool.query("delete from proactivity_settings");
      const next = await gateInitiation(pool, { ...base, now: new Date("2026-09-09T08:00:00Z") });
      expect(next.verdict).toBe("send");
    });
  });

  describe("a same-day dnd/quiet suppression is reused, never re-written", () => {
    // The lanes that pay for this: Saga keeps a reminder eligible under DND and Marcel ticks every
    // minute. One suppressed row per tick is up to ~1,440 rows a day for ONE item.
    const night = new Date("2026-09-08T20:30:00Z");        // 22:30 Oslo — quiet
    const aMinuteLater = new Date("2026-09-08T20:31:00Z");
    const yesterdayLate = new Date("2026-09-08T21:30:00Z"); // 23:30 Oslo on the 8th
    const todayEarly = new Date("2026-09-08T22:30:00Z");    // 00:30 Oslo on the 9th

    it("two DND gates for one item on one owner day cost ONE suppressed row", async () => {
      await pool.query("insert into proactivity_settings (owner, dnd) values ('bendik', true)");
      const first = await gateInitiation(pool, base);
      const second = await gateInitiation(pool, { ...base, now: new Date("2026-09-08T10:01:00Z") });
      expect(first).toMatchObject({ verdict: "suppress", reason: "dnd" });
      expect(second).toMatchObject({ verdict: "suppress", reason: "dnd" });
      const { rows } = await pool.query("select status, reason from initiations");
      expect(rows).toEqual([{ status: "suppressed", reason: "dnd" }]);
    });

    it("DND switched off between the two gates RELEASES the item — the decision is always re-run", async () => {
      // The reuse must never become a cache of the verdict: the settings are read on every tick, and
      // an owner turning DND off is the one change that has to take effect immediately.
      await pool.query("insert into proactivity_settings (owner, dnd) values ('bendik', true)");
      expect((await gateInitiation(pool, base)).verdict).toBe("suppress");
      await pool.query("delete from proactivity_settings");
      const released = await gateInitiation(pool, { ...base, now: new Date("2026-09-08T10:01:00Z") });
      expect(released.verdict).toBe("send");
      await released.confirm();
      const { rows } = await pool.query("select status, reason from initiations order by id");
      expect(rows).toEqual([{ status: "suppressed", reason: "dnd" }, { status: "sent", reason: null }]);
    });

    it("the reuse ends with the OWNER day, not with 24 h — 23:30 Oslo and 00:30 Oslo each get a row", async () => {
      await pool.query("insert into proactivity_settings (owner, dnd) values ('bendik', true)");
      await gateInitiation(pool, { ...base, now: yesterdayLate });
      await gateInitiation(pool, { ...base, now: todayEarly }); // one hour later, a new owner day
      const { rows } = await pool.query("select owner_day::text as day, reason from initiations order by owner_day");
      expect(rows).toEqual([{ day: "2026-09-08", reason: "dnd" }, { day: "2026-09-09", reason: "dnd" }]);
    });

    it("a quiet-hours suppression is reused within the day too (Marcel's dropped scheduled slot)", async () => {
      const slot = { ...base, cls: "scheduled" as const, itemKey: "trip/evening" };
      const first = await gateInitiation(pool, { ...slot, now: night });
      const second = await gateInitiation(pool, { ...slot, now: aMinuteLater });
      expect(first).toMatchObject({ verdict: "suppress", reason: "quiet-hours" });
      expect(second).toMatchObject({ verdict: "suppress", reason: "quiet-hours" });
      const { rows } = await pool.query("select status, reason from initiations");
      expect(rows).toEqual([{ status: "suppressed", reason: "quiet-hours" }]);
    });

    it("a suppression for a DIFFERENT reason still writes its own row", async () => {
      // Quiet hours first, then DND on the same owner day: two distinct facts, two rows.
      const slot = { ...base, cls: "scheduled" as const, itemKey: "trip/evening" };
      await gateInitiation(pool, { ...slot, now: night });
      await pool.query("insert into proactivity_settings (owner, dnd) values ('bendik', true)");
      await gateInitiation(pool, { ...slot, now: aMinuteLater });
      const { rows } = await pool.query("select reason from initiations order by id");
      expect(rows).toEqual([{ reason: "quiet-hours" }, { reason: "dnd" }]);
    });

    it("the reuse is per (owner, agent, itemKey) — another item is decided on its own merits", async () => {
      await pool.query("insert into proactivity_settings (owner, dnd) values ('bendik', true)");
      await gateInitiation(pool, base);
      await gateInitiation(pool, { ...base, itemKey: "msg-2" });
      await gateInitiation(pool, { ...base, agent: "marcel" });
      expect((await pool.query("select count(*)::int as n from initiations")).rows[0].n).toBe(3);
    });

    it("an already-seen suppression is NOT reused — it is terminal and cheap, and stays per call", async () => {
      const sent = await gateInitiation(pool, base);
      await sent.confirm();
      expect((await gateInitiation(pool, base))).toMatchObject({ verdict: "suppress", reason: "already-seen" });
      expect((await gateInitiation(pool, base))).toMatchObject({ verdict: "suppress", reason: "already-seen" });
      const { rows } = await pool.query("select status, reason from initiations order by id");
      expect(rows).toEqual([
        { status: "sent", reason: null },
        { status: "suppressed", reason: "already-seen" },
        { status: "suppressed", reason: "already-seen" },
      ]);
    });
  });

  describe("gatedSend", () => {
    it("sends, then confirms — in that order", async () => {
      const seen: string[] = [];
      const d = await gatedSend(pool, base, async () => {
        seen.push("sent");
        expect((await pool.query("select * from initiations")).rows).toHaveLength(0);
      });
      expect(d).toEqual({ verdict: "send" });
      expect(seen).toEqual(["sent"]);
      expect((await pool.query("select status from initiations")).rows).toEqual([{ status: "sent" }]);
    });

    it("does not call send() when the gate says no", async () => {
      await pool.query("insert into proactivity_settings (owner, dnd) values ('bendik', true)");
      const send = vi.fn(async () => {});
      const d = await gatedSend(pool, base, send);
      expect(d).toEqual({ verdict: "suppress", reason: "dnd" });
      expect(send).not.toHaveBeenCalled();
    });

    it("a failed send leaves no sent row — the item is retried, never lost", async () => {
      await expect(gatedSend(pool, base, async () => { throw new Error("telegram 502"); })).rejects.toThrow("telegram 502");
      expect((await pool.query("select * from initiations")).rows).toHaveLength(0);
      expect((await gateInitiation(pool, base)).verdict).toBe("send");
    });
  });

  describe("wouldSend (LAR-35-s2): the same verdict, never a sent row", () => {
    it("inside quiet hours: defer, and exactly one deferred row — a second call reuses it", async () => {
      const night = new Date("2026-09-08T20:30:00Z"); // 22:30 Oslo — quiet
      const aMinuteLater = new Date("2026-09-08T20:31:00Z");
      const first = await wouldSend(pool, { ...base, now: night });
      expect(first).toEqual({ verdict: "defer", reason: "quiet-hours", until: "2026-09-09T05:00:00.000Z" });
      const second = await wouldSend(pool, { ...base, now: aMinuteLater });
      expect(second).toEqual({ verdict: "defer", reason: "quiet-hours", until: "2026-09-09T05:00:00.000Z" });
      const { rows } = await pool.query("select status, reason from initiations");
      expect(rows).toEqual([{ status: "deferred", reason: "quiet-hours" }]); // one row per HOLD, not per call
    });

    it("outside quiet hours: send, and nothing at all is written — there is no confirm() to call", async () => {
      const d = await wouldSend(pool, base);
      expect(d).toEqual({ verdict: "send" });
      expect((await pool.query("select * from initiations")).rows).toHaveLength(0);
      // Calling it again proves the point: a real send never happened, so the item is still fresh.
      expect(await wouldSend(pool, base)).toEqual({ verdict: "send" });
      expect((await pool.query("select * from initiations")).rows).toHaveLength(0);
    });

    it("does not disturb gateInitiation's own ledger — a precheck's hold IS the real hold a send would see", async () => {
      const night = new Date("2026-09-08T20:30:00Z");
      await wouldSend(pool, { ...base, now: night });
      const real = await gateInitiation(pool, { ...base, now: new Date("2026-09-08T20:31:00Z") });
      expect(real).toMatchObject({ verdict: "defer", reason: "quiet-hours" });
      expect((await pool.query("select count(*)::int as n from initiations")).rows[0].n).toBe(1);
    });
  });

  describe("deferredSince", () => {
    it("groups the held-back items by door, counting each item once however often it was reconsidered", async () => {
      const night = new Date("2026-09-08T20:30:00Z");
      await gateInitiation(pool, { ...base, itemKey: "x", now: night });
      await gateInitiation(pool, { ...base, itemKey: "x", now: night }); // a later tick, same item
      await gateInitiation(pool, { ...base, itemKey: "y", now: night });
      await gateInitiation(pool, { ...base, door: "slack:C1", itemKey: "z", now: night });
      expect((await pool.query("select count(*)::int as n from initiations")).rows[0].n).toBe(3); // not 4
      expect(await deferredSince(pool, "bendik", new Date(Date.now() - 3600_000)))
        .toEqual([{ door: "slack:C1", count: 1 }, { door: "telegram:1", count: 2 }]);
    });

    it("an OPEN hold decided last night is still reported this morning", async () => {
      // The 22:30 hold until 07:00 is exactly what the 08:00 brief must mention, and its decided_at
      // is outside any window the brief would pass. Held open, so it counts.
      await pool.query(
        `insert into initiations (owner, agent, door, cls, item_key, status, reason, until_at, owner_day, decided_at)
         values ('bendik','saga','telegram:1','event','overnight','deferred','quiet-hours',
                 now() + interval '1 hour', current_date, now() - interval '8 hours')`,
      );
      expect(await deferredSince(pool, "bendik", new Date(Date.now() - 3600_000)))
        .toEqual([{ door: "telegram:1", count: 1 }]);
      // Once the hold has passed AND it was decided outside the window, it drops out.
      await pool.query("update initiations set until_at = now() - interval '1 minute'");
      expect(await deferredSince(pool, "bendik", new Date(Date.now() - 3600_000))).toEqual([]);
    });

    it("ignores anything decided before the window, and anything that was not deferred", async () => {
      const night = new Date("2026-09-08T20:30:00Z");
      await gateInitiation(pool, { ...base, itemKey: "x", now: night });
      await pool.query("update initiations set decided_at = now() - interval '3 days', until_at = now() - interval '3 days'");
      await (await gateInitiation(pool, base)).confirm();
      expect(await deferredSince(pool, "bendik", new Date(Date.now() - 3600_000))).toEqual([]);
    });
  });

  describe("a dead ledger fails OPEN for sending", () => {
    it("gateInitiation resolves send and warns, naming the consequence; confirm() never throws", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const dead = new Pool({ connectionString: "postgres://x:y@127.0.0.1:1/nope" });
      try {
        const d = await gateInitiation(dead, base);
        expect(d).toMatchObject({ verdict: "send" });
        await expect(d.confirm()).resolves.toBeUndefined();
      } finally { await dead.end(); }
      expect(warn).toHaveBeenCalled();
      const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).toMatch(/proactivity/);
      expect(said).toMatch(/send/i);
    });

    it("gatedSend still sends when the ledger is unreachable", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const dead = new Pool({ connectionString: "postgres://x:y@127.0.0.1:1/nope" });
      const send = vi.fn(async () => {});
      try {
        expect(await gatedSend(dead, base, send)).toEqual({ verdict: "send" });
      } finally { await dead.end(); }
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("wouldSend also fails open to send, and warns the same way", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const dead = new Pool({ connectionString: "postgres://x:y@127.0.0.1:1/nope" });
      try {
        expect(await wouldSend(dead, base)).toEqual({ verdict: "send" });
      } finally { await dead.end(); }
      expect(warn).toHaveBeenCalled();
    });
  });
});
