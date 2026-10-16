import { describe, it, expect } from "vitest";
import {
  sliceWindow, fetchMailboxEvents, makeCalendarSource, type EventSourceClient,
} from "../lib/adapters/calendar-source.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("sliceWindow", () => {
  it("splits a window into slices no wider than the given size", () => {
    const slices = sliceWindow(
      { timeMin: "2026-01-01T00:00:00.000Z", timeMax: "2026-01-10T00:00:00.000Z" },
      3 * DAY_MS,
    );
    expect(slices).toEqual([
      { timeMin: "2026-01-01T00:00:00.000Z", timeMax: "2026-01-04T00:00:00.000Z" },
      { timeMin: "2026-01-04T00:00:00.000Z", timeMax: "2026-01-07T00:00:00.000Z" },
      { timeMin: "2026-01-07T00:00:00.000Z", timeMax: "2026-01-10T00:00:00.000Z" },
    ]);
  });

  it("clamps the final slice to timeMax rather than overshooting", () => {
    const slices = sliceWindow(
      { timeMin: "2026-01-01T00:00:00.000Z", timeMax: "2026-01-08T00:00:00.000Z" },
      3 * DAY_MS,
    );
    expect(slices).toEqual([
      { timeMin: "2026-01-01T00:00:00.000Z", timeMax: "2026-01-04T00:00:00.000Z" },
      { timeMin: "2026-01-04T00:00:00.000Z", timeMax: "2026-01-07T00:00:00.000Z" },
      { timeMin: "2026-01-07T00:00:00.000Z", timeMax: "2026-01-08T00:00:00.000Z" },
    ]);
  });

  it("returns no slices for an empty or inverted window", () => {
    expect(sliceWindow({
      timeMin: "2026-01-05T00:00:00.000Z", timeMax: "2026-01-01T00:00:00.000Z",
    })).toEqual([]);
    expect(sliceWindow({
      timeMin: "2026-01-01T00:00:00.000Z", timeMax: "2026-01-01T00:00:00.000Z",
    })).toEqual([]);
  });

  it("defaults to slices no wider than 30 days", () => {
    // ~400 days back + 1 day forward is the service's default sync window (spec).
    const slices = sliceWindow({
      timeMin: "2025-06-29T09:00:00.000Z", timeMax: "2026-08-04T09:00:00.000Z",
    });
    expect(slices.length).toBeGreaterThan(1);
    for (const s of slices) {
      expect(Date.parse(s.timeMax) - Date.parse(s.timeMin)).toBeLessThanOrEqual(30 * DAY_MS);
    }
  });
});

describe("fetchMailboxEvents", () => {
  it("accumulates events across every slice instead of one un-paginated call", async () => {
    const calls: Array<{ timeMin: string; timeMax: string }> = [];
    const client: EventSourceClient = {
      listEvents: async (params) => {
        calls.push({ timeMin: params.timeMin, timeMax: params.timeMax });
        return { items: [{ id: `evt-${calls.length}`, summary: "x", start: params.timeMin }] };
      },
    };

    // 90 days at the default 30-day slice size must be more than one call — this is
    // what a single un-paginated call over the real ~400-day window was silently
    // skipping (Finding 1): only the newest slice's events used to be seen at all.
    const events = await fetchMailboxEvents(client, {
      timeMin: "2026-01-01T00:00:00.000Z", timeMax: "2026-04-01T00:00:00.000Z",
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(events).toHaveLength(calls.length); // every slice's event survived, none dropped
  });

  it("throws instead of silently truncating when a slice hits the result cap", async () => {
    const client: EventSourceClient = {
      listEvents: async () => ({
        items: Array.from({ length: 250 }, (_, i) => (
          { id: `e${i}`, summary: "x", start: "2026-01-01T00:00:00.000Z" }
        )),
      }),
    };

    await expect(
      fetchMailboxEvents(client, {
        timeMin: "2026-01-01T00:00:00.000Z", timeMax: "2026-01-10T00:00:00.000Z",
      }),
    ).rejects.toThrow(/cannot be paginated/);
  });

  it("carries attendees through unchanged and omits the field when absent", async () => {
    const client: EventSourceClient = {
      listEvents: async () => ({
        items: [
          { id: "e1", summary: "With", start: "2026-01-01T00:00:00.000Z", attendees: [{ email: "a@b.co" }] },
          { id: "e2", summary: "Without", start: "2026-01-02T00:00:00.000Z" },
        ],
      }),
    };
    const events = await fetchMailboxEvents(client, {
      timeMin: "2026-01-01T00:00:00.000Z", timeMax: "2026-01-03T00:00:00.000Z",
    });
    expect(events).toEqual([
      { id: "e1", summary: "With", start: "2026-01-01T00:00:00.000Z", attendees: [{ email: "a@b.co" }] },
      { id: "e2", summary: "Without", start: "2026-01-02T00:00:00.000Z" },
    ]);
  });
});

describe("makeCalendarSource", () => {
  it("throws when no mailbox is enrolled for the principal, instead of matching against nothing", async () => {
    const fakeDb = { query: async () => ({ rows: [], rowCount: 0 }) };
    const source = makeCalendarSource({
      db: fakeDb as any, keyHex: "0".repeat(64), orgs: [], principal: "U_nobody",
    });

    await expect(
      source.listEvents({ timeMin: "2026-01-01T00:00:00.000Z", timeMax: "2026-01-02T00:00:00.000Z" }),
    ).rejects.toThrow(/no enrolled calendar mailbox/);
  });

  it("refuses the same way when asked only for the owner's mailbox addresses", async () => {
    const fakeDb = { query: async () => ({ rows: [], rowCount: 0 }) };
    const source = makeCalendarSource({
      db: fakeDb as any, keyHex: "0".repeat(64), orgs: [], principal: "U_nobody",
    });

    await expect(source.ownerEmails()).rejects.toThrow(/no enrolled calendar mailbox/);
  });

  it("retries resolution after a failure instead of caching the error", async () => {
    // The container runs this hourly in one long-lived process; a memoised rejection
    // would wedge every later tick on one transient database blip.
    let calls = 0;
    const fakeDb = {
      query: async () => {
        calls += 1;
        if (calls === 1) throw new Error("db unreachable");
        return { rows: [], rowCount: 0 };
      },
    };
    const source = makeCalendarSource({
      db: fakeDb as any, keyHex: "0".repeat(64), orgs: [], principal: "U_nobody",
    });

    await expect(source.ownerEmails()).rejects.toThrow(/db unreachable/);
    await expect(source.ownerEmails()).rejects.toThrow(/no enrolled calendar mailbox/);
    expect(calls).toBe(2);
  });
});
