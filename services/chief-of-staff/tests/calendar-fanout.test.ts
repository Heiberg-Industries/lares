/**
 * ORB-118 — the multi-calendar fan-out. The 2026-08-17 evening brief read `primary` on ONE
 * account and said "nothing to say" while Tuesday held a three-hour meeting.
 *
 * The load-bearing case here is the LAST one: zero7's token row exists but its OAuth client is
 * not mounted on the agent box, and that must SKIP the account — not silence the brief.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { GoogleConfigError } from "@lares/agent-kit/google-auth";
import { GoogleUnenrolledError, wrapCalendarApi, type CalendarEvent, type CalendarSummary } from "../lib/google.js";
import {
  calendarDenyPatterns,
  listEventsEverywhere,
  selectBriefCalendars,
  type CalendarFanoutDeps,
  type FanoutCalendarClient,
} from "../lib/calendar-fanout.js";

const WINDOW = { timeMin: "2026-08-17T18:00:00Z", timeMax: "2026-08-19T18:00:00Z", max: 250 };

function cal(id: string, summary: string, primary = false): CalendarSummary {
  return { id, summary, primary };
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e-1", summary: "Folkepuls",
    start: "2026-08-18T11:00:00Z", end: "2026-08-18T13:50:00Z",
    ...overrides,
  };
}

/** A stub account: its calendars, and the events per calendar id. */
function client(calendars: CalendarSummary[], events: Record<string, CalendarEvent[]>): FanoutCalendarClient {
  return {
    listCalendars: async () => calendars,
    listEvents: async (o) => events[o.calendarId ?? "primary"] ?? [],
  };
}

afterEach(() => vi.restoreAllMocks());

describe("selectBriefCalendars", () => {
  it("keeps his own and shared calendars", () => {
    const out = selectBriefCalendars(
      [cal("primary", "Bendik Heiberg", true), cal("vdn", "Bendik Heiberg - VdN")],
      calendarDenyPatterns({} as NodeJS.ProcessEnv),
    );
    expect(out.map((c) => c.id)).toEqual(["primary", "vdn"]);
  });

  it("drops the all-day noise feeds — they would flood a brief that now counts all-day events", () => {
    const out = selectBriefCalendars(
      [
        cal("primary", "Bendik Heiberg", true),
        cal("bd", "Birthdays"),
        cal("hol", "Helligdager i Norge"),
        cal("tr", "TrainerRoad"),
        cal("tasks", "Tasks"),
      ],
      calendarDenyPatterns({} as NodeJS.ProcessEnv),
    );
    expect(out.map((c) => c.id)).toEqual(["primary"]);
  });

  it("never drops the primary calendar, whatever the deny list says", () => {
    const out = selectBriefCalendars([cal("primary", "Birthdays", true)], ["birthday"]);
    expect(out).toHaveLength(1);
  });

  it("BRIEF_CALENDAR_DENY overrides the defaults; empty keeps everything", () => {
    expect(calendarDenyPatterns({ BRIEF_CALENDAR_DENY: "foo, BAR " } as unknown as NodeJS.ProcessEnv)).toEqual(["foo", "bar"]);
    expect(calendarDenyPatterns({ BRIEF_CALENDAR_DENY: "" } as unknown as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("wrapCalendarApi.listCalendars — read-only inclusion", () => {
  // Verified against the real account 2026-08-18: "Bendik Heiberg - VdN" comes back with
  // accessRole "reader", so the write-oriented default filter hid his Vol de Nuit meetings.
  const api = {
    calendarList: {
      list: async () => ({
        data: {
          items: [
            { id: "primary", summary: "Bendik Heiberg", primary: true, accessRole: "owner" },
            { id: "vdn", summary: "Bendik Heiberg - VdN", accessRole: "reader" },
          ],
        },
      }),
    },
  } as never;

  it("hides a read-only calendar by default — a create-event tool may only offer writable ones", async () => {
    expect((await wrapCalendarApi(api).listCalendars()).map((c) => c.id)).toEqual(["primary"]);
  });

  it("includes it when asked — the brief reads calendars he cannot write", async () => {
    expect((await wrapCalendarApi(api).listCalendars({ includeReadOnly: true })).map((c) => c.id))
      .toEqual(["primary", "vdn"]);
  });
});

describe("listEventsEverywhere", () => {
  it("asks for read-only calendars, so a subscribed calendar is not silently skipped", async () => {
    let asked: unknown = "never called";
    const deps: CalendarFanoutDeps = {
      accounts: async () => ["owner@owner.example"],
      clientFor: async () => ({
        listCalendars: async (opts) => { asked = opts; return [cal("primary", "Bendik Heiberg", true)]; },
        listEvents: async () => [event()],
      }),
    };
    await listEventsEverywhere(deps, WINDOW);
    expect(asked).toEqual({ includeReadOnly: true });
  });

  it("reads every kept calendar of every account, not just primary", async () => {
    const deps: CalendarFanoutDeps = {
      accounts: async () => ["owner@owner.example", "owner@project.example"],
      clientFor: async (account) =>
        account === "owner@owner.example"
          ? client([cal("primary", "Bendik Heiberg", true), cal("vdn", "Bendik Heiberg - VdN")], {
              primary: [event({ id: "h-1", summary: "Folkepuls" })],
              vdn: [event({ id: "v-1", summary: "VdN styremøte" })],
            })
          : client([cal("primary", "Bendik Heiberg · ZERO7", true)], {
              primary: [event({ id: "z-1", summary: "Zero7 standup" })],
            }),
    };
    const out = await listEventsEverywhere(deps, WINDOW);
    expect(out.map((e) => e.summary).sort()).toEqual(["Folkepuls", "VdN styremøte", "Zero7 standup"]);
  });

  it("the same commitment copied onto two calendars appears ONCE (different ids, same event)", async () => {
    const deps: CalendarFanoutDeps = {
      accounts: async () => ["owner@owner.example"],
      clientFor: async () =>
        client([cal("primary", "Bendik Heiberg", true), cal("other", "Prosjekt")], {
          primary: [event({ id: "copy-a" })],
          other: [event({ id: "copy-b" })],   // the Folkepuls case: a copy, its own id
        }),
    };
    expect(await listEventsEverywhere(deps, WINDOW)).toHaveLength(1);
  });

  it("SKIPS an account whose OAuth client is not mounted here — zero7 must not silence the brief", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps: CalendarFanoutDeps = {
      accounts: async () => ["owner@owner.example", "owner@project.example"],
      clientFor: async (account) => {
        if (account === "owner@project.example") throw new GoogleConfigError("google client secrets for org zero7 are not mounted");
        return client([cal("primary", "Bendik Heiberg", true)], { primary: [event()] });
      },
    };
    const out = await listEventsEverywhere(deps, WINDOW);
    expect(out).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("owner@project.example"));
  });

  it("an unenrolled account is skipped the same way", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps: CalendarFanoutDeps = {
      accounts: async () => ["gone@owner.example", "owner@owner.example"],
      clientFor: async (account) => {
        if (account === "gone@owner.example") throw new GoogleUnenrolledError("U_bendik", account);
        return client([cal("primary", "Bendik Heiberg", true)], { primary: [event()] });
      },
    };
    expect(await listEventsEverywhere(deps, WINDOW)).toHaveLength(1);
  });

  it("THROWS when no account could be reached — an empty list would read as an empty day", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps: CalendarFanoutDeps = {
      accounts: async () => ["owner@project.example"],
      clientFor: async () => { throw new GoogleConfigError("not mounted"); },
    };
    await expect(listEventsEverywhere(deps, WINDOW)).rejects.toThrow(/no calendar could be read/);
  });

  it("THROWS on a real read failure — a broken read is not a quiet day", async () => {
    const deps: CalendarFanoutDeps = {
      accounts: async () => ["owner@owner.example"],
      clientFor: async () => ({
        listCalendars: async () => [cal("primary", "Bendik Heiberg", true)],
        listEvents: async () => { throw new Error("ECONNRESET"); },
      }),
    };
    await expect(listEventsEverywhere(deps, WINDOW)).rejects.toThrow(/ECONNRESET/);
  });

  it("LAR-59-s1: stamps each event with the account and calendar it came from", async () => {
    const deps: CalendarFanoutDeps = {
      accounts: async () => ["owner@owner.example", "owner@project.example"],
      clientFor: async (account) =>
        account === "owner@owner.example"
          ? client([cal("primary", "Bendik Heiberg", true), cal("vdn", "Bendik Heiberg - VdN")], {
              primary: [event({ id: "h-1", summary: "Folkepuls" })],
              vdn: [event({ id: "v-1", summary: "VdN styremøte" })],
            })
          : client([cal("primary", "Bendik Heiberg · ZERO7", true)], {
              primary: [event({ id: "z-1", summary: "Zero7 standup" })],
            }),
    };
    const out = await listEventsEverywhere(deps, WINDOW);
    const byId = new Map(out.map((e) => [e.id, e]));
    expect(byId.get("h-1")).toMatchObject({ account: "owner@owner.example", calendarId: "primary" });
    expect(byId.get("v-1")).toMatchObject({ account: "owner@owner.example", calendarId: "vdn" });
    expect(byId.get("z-1")).toMatchObject({ account: "owner@project.example", calendarId: "primary" });
  });

  it("LAR-59-s1: the first-seen copy's stamp wins when the same commitment is read off two calendars", async () => {
    const deps: CalendarFanoutDeps = {
      accounts: async () => ["owner@owner.example"],
      clientFor: async () =>
        client([cal("primary", "Bendik Heiberg", true), cal("other", "Prosjekt")], {
          primary: [event({ id: "copy-a" })],
          other: [event({ id: "copy-b" })],
        }),
    };
    const out = await listEventsEverywhere(deps, WINDOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "copy-a", account: "owner@owner.example", calendarId: "primary" });
  });

  it("THROWS when one calendar hits its ceiling — the rest were cut off", async () => {
    const deps: CalendarFanoutDeps = {
      accounts: async () => ["owner@owner.example"],
      clientFor: async () =>
        client([cal("primary", "Bendik Heiberg", true)], {
          primary: Array.from({ length: 250 }, (_, i) => event({ id: `e-${i}`, summary: `evt ${i}` })),
        }),
    };
    await expect(listEventsEverywhere(deps, WINDOW)).rejects.toThrow(/ceiling/);
  });
});
