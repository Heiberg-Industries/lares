// Tests for agent/tools/calendar_list_events.ts (Task 11). Per the brief: marshals the
// request correctly against a STUBBED googleapis client — `CalendarListEventsDeps.client()` is
// the only injected seam, mirroring agent/tools/weather_forecast.ts's own `WeatherForecastDeps`
// shape. The unenrolled/unscoped-principal error path is covered against a REAL Postgres in
// tests/google.test.ts's own `calendarClient` describe block (same pattern as `gmailClient`
// there) — this file only proves the TOOL's own marshalling, call-shaping, and admin-DM-gate
// logic.
//
// admin-DM gate added in the fix round following task review (2026-08-17): this tool touches
// the same class of personal Google-account data sveip.ts does, and — per the review finding —
// this codebase's own established pattern is that every tool in that position (sveip.ts,
// nytur.ts, link_group.ts, toggle_kill_switch.ts) self-gates with an inline
// `assertAdminDm(ctx.session.auth)` call, since there is no per-session tool scoping: any
// dispatched turn, group or DM, can reach any registered tool once the Gatekeeper lets a group
// message through. `auth()`/`ctx()` below mirror tests/sveip.test.ts's own helpers of the same
// name exactly (duplicated rather than imported, matching this test suite's per-file
// self-containment convention).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { calendar_v3 } from "googleapis";

import { createCalendarListEventsTool, type CalendarListEventsDeps } from "../catalogue/calendar_list_events.js";

const ADMIN_ID = "123456789";
const OTHER_ID = "999999999";

function auth(overrides: Partial<{ chatType: string; userId: string }> = {}) {
  const chatType = overrides.chatType ?? "private";
  const userId = overrides.userId ?? ADMIN_ID;
  return {
    authenticator: "telegram-webhook",
    principalId: chatType === "private" ? `telegram:${userId}` : `telegram:-100123:${userId}`,
    principalType: "user",
    attributes: { chat_id: chatType === "private" ? userId : "-100123", chat_type: chatType, user_id: userId },
  } as never;
}

function ctx(a: unknown) {
  return { session: { id: "wrun_test", auth: { current: a, initiator: a } } } as never;
}

const ADMIN_DM_CTX = ctx(auth());

function stubCalendarClient(events: calendar_v3.Schema$Event[]): { deps: CalendarListEventsDeps; list: ReturnType<typeof vi.fn> } {
  const list = vi.fn(async () => ({ data: { items: events } }));
  const client = { events: { list } } as unknown as calendar_v3.Calendar;
  return { deps: { client: async () => client }, list };
}

beforeEach(() => {
  process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
});

afterEach(() => {
  delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
});

describe("calendar_list_events — request marshalling (admin-DM context)", () => {
  it("calls events.list with calendarId 'primary', the given from/to as timeMin/timeMax, singleEvents and orderBy set", async () => {
    const { deps, list } = stubCalendarClient([]);
    const tool = createCalendarListEventsTool(deps);

    await tool.execute({ from: "2026-08-20T00:00:00Z", to: "2026-08-27T00:00:00Z" }, ADMIN_DM_CTX);

    expect(list).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: "2026-08-20T00:00:00Z",
      timeMax: "2026-08-27T00:00:00Z",
      singleEvents: true,
      orderBy: "startTime",
    });
  });

  it("marshals a real Google event into the tool's plain output shape", async () => {
    const { deps } = stubCalendarClient([
      {
        id: "evt1",
        summary: "Middag med familien",
        location: "Restaurant Le Petit, Aix-en-Provence",
        htmlLink: "https://calendar.google.com/event?eid=evt1",
        start: { dateTime: "2026-08-21T18:00:00+02:00" },
        end: { dateTime: "2026-08-21T20:00:00+02:00" },
      },
    ]);
    const tool = createCalendarListEventsTool(deps);

    const result = await tool.execute({ from: "2026-08-20T00:00:00Z", to: "2026-08-27T00:00:00Z" }, ADMIN_DM_CTX);

    expect(result).toEqual([
      {
        id: "evt1",
        summary: "Middag med familien",
        location: "Restaurant Le Petit, Aix-en-Provence",
        htmlLink: "https://calendar.google.com/event?eid=evt1",
        start: "2026-08-21T18:00:00+02:00",
        end: "2026-08-21T20:00:00+02:00",
      },
    ]);
  });

  it("falls back to an all-day event's `date` field when `dateTime` is absent", async () => {
    const { deps } = stubCalendarClient([
      { id: "evt2", summary: "Bursdag", start: { date: "2026-08-22" }, end: { date: "2026-08-23" } },
    ]);
    const tool = createCalendarListEventsTool(deps);

    const result = await tool.execute({ from: "2026-08-20T00:00:00Z", to: "2026-08-27T00:00:00Z" }, ADMIN_DM_CTX);

    expect(result).toEqual([{ id: "evt2", summary: "Bursdag", start: "2026-08-22", end: "2026-08-23" }]);
  });

  it("omits summary/location/htmlLink/start/end entirely when Google didn't return them — never fabricates a field", async () => {
    const { deps } = stubCalendarClient([{ id: "evt3" }]);
    const tool = createCalendarListEventsTool(deps);

    const result = await tool.execute({ from: "2026-08-20T00:00:00Z", to: "2026-08-27T00:00:00Z" }, ADMIN_DM_CTX);

    expect(result).toEqual([{ id: "evt3" }]);
  });

  it("returns an empty array when Google returns no items at all", async () => {
    const list = vi.fn(async () => ({ data: {} }));
    const client = { events: { list } } as unknown as calendar_v3.Calendar;
    const tool = createCalendarListEventsTool({ client: async () => client });

    const result = await tool.execute({ from: "2026-08-20T00:00:00Z", to: "2026-08-27T00:00:00Z" }, ADMIN_DM_CTX);

    expect(result).toEqual([]);
  });

  it("propagates the deps.client() error untouched — e.g. GoogleUnenrolledError from lib/google.ts", async () => {
    class FakeUnenrolled extends Error {}
    const tool = createCalendarListEventsTool({
      client: async () => {
        throw new FakeUnenrolled("no oauth_tokens row");
      },
    });

    await expect(
      tool.execute({ from: "2026-08-20T00:00:00Z", to: "2026-08-27T00:00:00Z" }, ADMIN_DM_CTX),
    ).rejects.toThrow(FakeUnenrolled);
  });
});

describe("calendar_list_events — admin-DM-only gate", () => {
  it("refuses a group-chat call even from the admin's own user id, and never calls the Calendar client at all", async () => {
    const { deps, list } = stubCalendarClient([]);
    const tool = createCalendarListEventsTool(deps);

    await expect(
      tool.execute(
        { from: "2026-08-20T00:00:00Z", to: "2026-08-27T00:00:00Z" },
        ctx(auth({ chatType: "group" })),
      ),
    ).rejects.toThrow(/admin-DM only/);

    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a private-chat call from a non-admin user id", async () => {
    const { deps, list } = stubCalendarClient([]);
    const tool = createCalendarListEventsTool(deps);

    await expect(
      tool.execute({ from: "2026-08-20T00:00:00Z", to: "2026-08-27T00:00:00Z" }, ctx(auth({ userId: OTHER_ID }))),
    ).rejects.toThrow(/admin-DM only/);

    expect(list).not.toHaveBeenCalled();
  });

  it("refuses when session auth is entirely absent", async () => {
    const { deps, list } = stubCalendarClient([]);
    const tool = createCalendarListEventsTool(deps);

    await expect(
      tool.execute({ from: "2026-08-20T00:00:00Z", to: "2026-08-27T00:00:00Z" }, ctx(null)),
    ).rejects.toThrow(/admin-DM only/);

    expect(list).not.toHaveBeenCalled();
  });

  it("falls back from an absent `current` auth to `initiator`, matching the fleet's Telegram-HITL-resume convention", async () => {
    const { deps, list } = stubCalendarClient([]);
    const tool = createCalendarListEventsTool(deps);
    const initiatorOnly = { session: { id: "wrun_test", auth: { current: null, initiator: auth() } } } as never;

    await tool.execute({ from: "2026-08-20T00:00:00Z", to: "2026-08-27T00:00:00Z" }, initiatorOnly);

    expect(list).toHaveBeenCalledTimes(1);
  });

  it("admits the admin in a private chat", async () => {
    const { deps, list } = stubCalendarClient([]);
    const tool = createCalendarListEventsTool(deps);

    await tool.execute({ from: "2026-08-20T00:00:00Z", to: "2026-08-27T00:00:00Z" }, ADMIN_DM_CTX);

    expect(list).toHaveBeenCalledTimes(1);
  });
});
