/**
 * catalogue/calendar_conflicts.ts — LAR-59-s5, on request the tool returns the proposed fix.
 *
 * PIN FIRST: the first group below runs the tool with events that produce a real
 * `overlapping-stay` clash but NO cancellation mail anywhere in the mocked mailbox, and asserts
 * the row comes back exactly as detection alone would have produced it — no `resolution` key,
 * nothing extra. That is today's contract (LAR-59-s3 landed the resolver as a library only;
 * this slice is what first wires it into a live tool), and it must hold before anything below
 * is allowed to depend on the new wiring actually attaching a proposal.
 *
 * `../lib/calendar-fanout.js` is mocked to hand back events directly, already stamped with
 * `account`/`calendarId` the way the real fan-out does (LAR-59-s1) — this file is about the
 * TOOL's wiring, not the fan-out or the detector, both covered elsewhere
 * (tests/calendar-fanout.test.ts, tests/calendar-conflicts.test.ts). `../lib/google.js` is
 * mocked only for the `gmail()` factory `resolveConflicts` needs; `listEnrolledMailboxes` and
 * `googleClients().calendar` are never called once the fan-out itself is replaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { CalendarEvent, MailMessage } from "../lib/google.js";

const ctx = {} as never;

function stayEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    summary: "Stay at The Standard",
    start: "2026-08-26",
    end: "2026-08-31",
    account: "owner@example.invalid",
    calendarId: "primary",
    ...overrides,
  } as CalendarEvent;
}

function cancellationMail(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "m1",
    threadId: "t1",
    from: "Vendor <vendor@example.invalid>",
    to: ["owner@example.invalid"],
    subject: "Your reservation at The Standard has been cancelled",
    bodyText: "Cancelled. Your stay on 26 Aug 2026 has been cancelled.",
    sentAt: "2026-08-01T09:00:00Z",
    messageId: "<m1@example.invalid>",
    references: "",
    isCalendarNotice: false,
    cc: [],
    ...overrides,
  };
}

function mockFanout(events: CalendarEvent[]) {
  vi.doMock("../lib/calendar-fanout.js", () => ({
    listEventsEverywhere: async () => events,
  }));
}

function mockGoogle(gmail: { search: (q: string, max: number) => Promise<string[]>; read: (id: string) => Promise<MailMessage | null> }) {
  vi.doMock("../lib/google.js", () => ({
    googleClients: () => ({ gmail: async () => gmail }),
    listEnrolledMailboxes: async () => ["owner@example.invalid"],
  }));
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  vi.doUnmock("../lib/calendar-fanout.js");
  vi.doUnmock("../lib/google.js");
  vi.doUnmock("../lib/conflict-resolution.js");
});

describe("calendar_conflicts — pin: no cancellation mail anywhere", () => {
  it("an overlapping-stay clash with nothing in the mailbox carries no resolution", async () => {
    mockFanout([
      stayEvent(),
      stayEvent({ id: "e2", summary: "Stay at The Plaza", account: "owner@example.invalid", calendarId: "primary" }),
    ]);
    mockGoogle({ search: async () => [], read: async () => null });

    const tool = (await import("../catalogue/calendar_conflicts.js")).default;
    const result = (await tool.execute({ from: "2026-08-26", days: 1 }, ctx)) as {
      conflicts: Array<{ kind: string; resolution?: unknown }>;
    };

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.kind).toBe("overlapping-stay");
    expect(result.conflicts[0]!.resolution).toBeUndefined();
    expect("resolution" in result.conflicts[0]!).toBe(false);
  });
});

describe("calendar_conflicts — a strong match attaches the proposed fix", () => {
  it("names the stale event, its account/calendarId, and the evidence sentence verbatim", async () => {
    mockFanout([
      stayEvent(), // e1 — The Standard, cancelled below
      stayEvent({ id: "e2", summary: "Stay at The Plaza", account: "owner@example.invalid", calendarId: "second-calendar" }),
    ]);
    mockGoogle({
      search: async (query: string) => (query.includes("The Standard") ? ["m1"] : []),
      read: async (id: string) => (id === "m1" ? cancellationMail() : null),
    });

    const tool = (await import("../catalogue/calendar_conflicts.js")).default;
    const result = (await tool.execute({ from: "2026-08-26", days: 1 }, ctx)) as {
      conflicts: Array<{
        kind: string;
        events: Array<{ id: string }>;
        resolution?: { staleEventId: string; account?: string; calendarId?: string; strength: string; sentence: string };
      }>;
    };

    expect(result.conflicts).toHaveLength(1);
    const resolution = result.conflicts[0]!.resolution;
    expect(resolution).toBeDefined();
    expect(resolution!.staleEventId).toBe("e1");
    expect(resolution!.account).toBe("owner@example.invalid");
    expect(resolution!.calendarId).toBe("primary"); // e1's own calendar, not e2's
    expect(resolution!.strength).toBe("strong");
    expect(resolution!.sentence).toBe('Cancellation mail from Vendor, 1 Aug 2026: "Your reservation at The Standard has been cancelled".');
  });

  it("never lets the mail choose which event — a mail naming an unrelated vendor changes nothing", async () => {
    mockFanout([stayEvent(), stayEvent({ id: "e2", summary: "Stay at The Plaza" })]);
    mockGoogle({
      // A mail exists, but it cancels neither "The Standard" nor "The Plaza" — the query for
      // each vendor simply returns nothing, so no resolution can be manufactured from it.
      search: async () => [],
      read: async () => null,
    });

    const tool = (await import("../catalogue/calendar_conflicts.js")).default;
    const result = (await tool.execute({ from: "2026-08-26", days: 1 }, ctx)) as {
      conflicts: Array<{ resolution?: unknown }>;
    };
    expect(result.conflicts[0]!.resolution).toBeUndefined();
  });
});

describe("calendar_conflicts — a resolver failure still returns the plain conflicts", () => {
  it("a thrown mailbox search does not fail the tool and drops no findings", async () => {
    mockFanout([stayEvent(), stayEvent({ id: "e2", summary: "Stay at The Plaza" })]);
    mockGoogle({
      search: async () => { throw new Error("mailbox unreachable"); },
      read: async () => null,
    });

    const tool = (await import("../catalogue/calendar_conflicts.js")).default;
    const result = (await tool.execute({ from: "2026-08-26", days: 1 }, ctx)) as {
      conflicts: Array<{ kind: string; resolution?: unknown }>;
    };

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.kind).toBe("overlapping-stay");
    expect(result.conflicts[0]!.resolution).toBeUndefined();
  });

  it("a resolveConflicts call that rejects outright still answers with the plain conflicts", async () => {
    // Belt-and-braces: even though lib/conflict-resolution.ts documents itself as never
    // throwing, the tool's own `.catch` must survive a rejection anyway.
    mockFanout([stayEvent(), stayEvent({ id: "e2", summary: "Stay at The Plaza" })]);
    vi.doMock("../lib/conflict-resolution.js", () => ({
      resolveConflicts: async () => { throw new Error("boom"); },
    }));
    mockGoogle({ search: async () => [], read: async () => null });

    const tool = (await import("../catalogue/calendar_conflicts.js")).default;
    const result = (await tool.execute({ from: "2026-08-26", days: 1 }, ctx)) as {
      conflicts: Array<{ kind: string; resolution?: unknown }>;
    };
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.resolution).toBeUndefined();
  });
});

describe("calendar_conflicts — the write-shape", () => {
  it("has no write path at all — no approval gate, ever", async () => {
    mockFanout([]);
    mockGoogle({ search: async () => [], read: async () => null });
    const tool = (await import("../catalogue/calendar_conflicts.js")).default;
    expect((tool as { approval?: unknown }).approval).toBeUndefined();
  });
});
