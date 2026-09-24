import { describe, it, expect } from "vitest";
import { encryptSecret } from "@lares/agent-box";
import { wrapCalendarApi, makeCalendarResolver } from "../lib/adapters/calendar-oauth.js";

/**
 * ORB-178 — the attendee resolver, rehomed from services/agent-runtime/lib/adapters/
 * calendar-oauth.ts (its read half). The cases are the runtime's own (tests/calendar-oauth.test.ts
 * there) plus the two ORB-156 fields notion-sync depends on: attendees and recurringEventId.
 */
const KEY = "0".repeat(64);

function fakeApi(items: unknown[]) {
  return { events: { async list() { return { data: { items } }; } } } as never;
}

describe("wrapCalendarApi (read half)", () => {
  it("flattens dateTime/date into {id,summary,start,end} and omits attendees when there are none", async () => {
    const client = wrapCalendarApi(fakeApi([
      { id: "e1", summary: "Sync", start: { dateTime: "2026-06-30T09:00:00Z" }, end: { dateTime: "2026-06-30T09:30:00Z" } },
      { id: "e2", summary: "All day", start: { date: "2026-07-01" }, end: { date: "2026-07-02" } },
    ]));
    const res = await client.listEvents({ timeMin: "a", timeMax: "b", maxResults: 10 });
    expect(res.items).toEqual([
      { id: "e1", summary: "Sync", start: "2026-06-30T09:00:00Z", end: "2026-06-30T09:30:00Z" },
      { id: "e2", summary: "All day", start: "2026-07-01", end: "2026-07-02" },
    ]);
  });

  it("keeps human attendees with displayName/responseStatus, drops resources and email-less entries, surfaces recurringEventId", async () => {
    const client = wrapCalendarApi(fakeApi([{
      id: "e3", summary: "Board", start: { dateTime: "s" }, end: { dateTime: "e" }, recurringEventId: "series-1",
      attendees: [
        { email: "a@x.co", displayName: "A", responseStatus: "accepted" },
        { email: "room@x.co", resource: true },
        { displayName: "no email" },
        { email: "b@x.co" },
      ],
    }]));
    const { items } = await client.listEvents({ timeMin: "a", timeMax: "b", maxResults: 10 });
    expect(items[0]).toEqual({
      id: "e3", summary: "Board", start: "s", end: "e", recurringEventId: "series-1",
      attendees: [{ email: "a@x.co", displayName: "A", responseStatus: "accepted" }, { email: "b@x.co" }],
    });
    expect("responseStatus" in items[0]!.attendees![1]!).toBe(false);   // absent key, not an explicit undefined
  });

  it("asks Google for the primary calendar unless told otherwise, single events ordered by start", async () => {
    const seen: unknown[] = [];
    const api = { events: { async list(args: unknown) { seen.push(args); return { data: { items: [] } }; } } } as never;
    await wrapCalendarApi(api).listEvents({ timeMin: "a", timeMax: "b", maxResults: 5 });
    expect(seen[0]).toMatchObject({ calendarId: "primary", singleEvents: true, orderBy: "startTime", maxResults: 5 });
  });
});

describe("makeCalendarResolver", () => {
  const rows = [
    { refresh_token_enc: encryptSecret("rt-h", KEY), scopes: [], email_address: "owner@owner.example", org_id: "heiberg" },
    { refresh_token_enc: encryptSecret("rt-z", KEY), scopes: [], email_address: "owner@project.example", org_id: "zero7" },
  ];
  const db = { query: async () => ({ rows, rowCount: rows.length }) } as never;
  const orgs = [{ orgId: "zero7", clientId: "C_Z", clientSecret: "s", redirectUri: "" }];

  it("resolveAll builds one client per mailbox whose org has a client config, and skips (warns) the rest", async () => {
    const picked: string[] = [];
    const warns: string[] = [];
    const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)); };
    try {
      const r = makeCalendarResolver({ db, keyHex: KEY, orgs, calendarFactory: (cfg, rt) => { picked.push(`${cfg.clientId}:${rt}`); return fakeApi([]); } });
      const all = await r.resolveAll("U_bendik");
      expect(all.map((m) => m.emailAddress)).toEqual(["owner@project.example"]);
      expect(picked).toEqual(["C_Z:rt-z"]);
      expect(warns.join("\n")).toMatch(/skipping owner@owner.example — no OAuth client config for org 'heiberg'/);
    } finally { console.warn = orig; }
  });

  it("resolveForEmail returns the matching mailbox's client, null for an unknown address, and throws for a mailbox whose org is unconfigured", async () => {
    const r = makeCalendarResolver({ db, keyHex: KEY, orgs, calendarFactory: () => fakeApi([]) });
    expect(await r.resolveForEmail("U_bendik", "owner@project.example")).not.toBeNull();
    expect(await r.resolveForEmail("U_bendik", "x@nope.co")).toBeNull();
    await expect(r.resolveForEmail("U_bendik", "owner@owner.example")).rejects.toThrow(/no OAuth client config for org 'heiberg'/);
  });
});
