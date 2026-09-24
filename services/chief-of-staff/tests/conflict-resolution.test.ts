/**
 * lib/conflict-resolution.ts — LAR-59-s3, the bounded mailbox search per clash. Every Gmail
 * client here is a fake (`fakeDeps`); nothing in this file makes a network call.
 *
 * FOUR-WAY ACCEPTANCE (safety rule from the coordinator): a resolution is attached only when
 * EXACTLY ONE of a stay clash's two bookings has a STRONG match — two strong, none, and any
 * weak-only case (including "a cancellation of a different booking at the same vendor", which
 * `tests/conflict-evidence.test.ts` already shows is only ever weak) must all leave the plain
 * flag standing. All four are tested below.
 *
 * A second group of tests proves the property that matters most for a feature that can end in
 * a calendar delete: mail text can never choose WHICH event a resolution names, and can never
 * manufacture a clash `detectCalendarConflicts` did not raise. `resolveConflicts` only ever
 * walks the `conflicts` array it was given, and a resolution's `staleEventId` only ever comes
 * from that array's own calendar data.
 */
import { describe, it, expect, vi } from "vitest";

import {
  resolveConflicts,
  buildCancellationQuery,
  MAX_CLASHES_PER_PASS,
  MAX_MESSAGES_PER_EVENT,
  type ConflictResolutionDeps,
} from "../lib/conflict-resolution.js";
import type { CalendarConflict, ConflictEventRef } from "../lib/calendar-conflicts.js";
import type { MailMessage } from "../lib/google.js";

function ref(overrides: Partial<ConflictEventRef> = {}): ConflictEventRef {
  return { id: "e1", title: "Stay at The Standard", start: "2026-08-26", end: "2026-08-31", ...overrides };
}

function stayConflict(a: Partial<ConflictEventRef>, b: Partial<ConflictEventRef>): CalendarConflict {
  return {
    kind: "overlapping-stay",
    severity: "high",
    events: [ref(a), ref(b)],
    explanation: "Two places to sleep are booked over the night of 2026-08-26.",
  };
}

function doubleBooked(): CalendarConflict {
  return {
    kind: "double-booked",
    severity: "high",
    events: [
      ref({ id: "m1", title: "Board call", start: "2026-08-26T10:00:00+02:00", end: "2026-08-26T11:00:00+02:00" }),
      ref({ id: "m2", title: "Investor intro", start: "2026-08-26T10:30:00+02:00", end: "2026-08-26T11:30:00+02:00" }),
    ],
    explanation: '"Board call" and "Investor intro" overlap in time — they cannot both happen as booked.',
  };
}

function mail(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "msg-1",
    threadId: "t1",
    from: "Vendor <vendor@example.invalid>",
    to: ["owner@example.invalid"],
    subject: "Your reservation has been cancelled",
    bodyText: "Cancelled for 26 Aug 2026.",
    sentAt: "2026-08-01T09:00:00Z",
    messageId: "<msg-1@example.invalid>",
    references: "",
    isCalendarNotice: false,
    cc: [],
    ...overrides,
  };
}

/** A fake `ConflictResolutionDeps` whose mailbox is a fixed `query -> ids` function plus an
 *  `id -> mail` map. Records every `search` call and every `read` id, so the caps can be
 *  asserted precisely rather than inferred from behaviour alone. */
function fakeDeps(
  opts: {
    idsForQuery?: (query: string, account: string | undefined) => string[];
    mailFor?: Record<string, MailMessage>;
  } = {},
): ConflictResolutionDeps & { calls: Array<{ account: string | undefined; query: string; max: number }>; reads: string[] } {
  const calls: Array<{ account: string | undefined; query: string; max: number }> = [];
  const reads: string[] = [];
  return {
    calls,
    reads,
    async gmailFor(account) {
      return {
        async search(query: string, max: number) {
          calls.push({ account, query, max });
          return opts.idsForQuery ? opts.idsForQuery(query, account) : [];
        },
        async read(id: string) {
          reads.push(id);
          return opts.mailFor?.[id] ?? null;
        },
      };
    },
  };
}

describe("buildCancellationQuery", () => {
  it("quotes the vendor, ORs the cancel terms, and windows the date around check-in", () => {
    expect(buildCancellationQuery("The Standard", "2026-08-26")).toBe(
      '"The Standard" (cancelled OR canceled OR cancellation OR kansellert OR avbestilt OR avbestilling) after:2026/04/28 before:2026/08/27',
    );
  });
});

describe("resolveConflicts — the four-way acceptance", () => {
  it("exactly one strong match: attaches a resolution naming the right event id", async () => {
    const conflict = stayConflict(
      { id: "standard-1", account: "owner@example.invalid", calendarId: "primary" },
      { id: "public-1", title: "Stay at PUBLIC Hotel New York" },
    );
    const deps = fakeDeps({
      idsForQuery: (query) => (query.includes("The Standard") ? ["msg-1"] : []),
      mailFor: {
        "msg-1": mail({
          subject: "Your reservation at The Standard has been cancelled",
          bodyText: "Cancelled for 26 Aug 2026.",
        }),
      },
    });
    const [resolved] = await resolveConflicts([conflict], deps);
    expect(resolved!.resolution).toMatchObject({
      staleEventId: "standard-1",
      account: "owner@example.invalid",
      calendarId: "primary",
      strength: "strong",
    });
    expect(resolved!.resolution!.sentence).toContain("The Standard");
  });

  it("both events matched (both strong): no resolution — the plain flag stands", async () => {
    const conflict = stayConflict(
      { id: "standard-1" },
      { id: "public-1", title: "Stay at PUBLIC Hotel New York" },
    );
    const deps = fakeDeps({
      idsForQuery: () => ["msg-1"],
      mailFor: {
        "msg-1": mail({
          subject: "Your reservations at The Standard and PUBLIC Hotel New York have both been cancelled",
          bodyText: "Cancelled for 26 Aug 2026.",
        }),
      },
    });
    const [resolved] = await resolveConflicts([conflict], deps);
    expect(resolved!.resolution).toBeUndefined();
  });

  it("no match on either side: no resolution", async () => {
    const conflict = stayConflict(
      { id: "standard-1" },
      { id: "public-1", title: "Stay at PUBLIC Hotel New York" },
    );
    const deps = fakeDeps({ idsForQuery: () => [] });
    const [resolved] = await resolveConflicts([conflict], deps);
    expect(resolved!.resolution).toBeUndefined();
  });

  it("a weak-only match (a cancellation for a DIFFERENT booking at the same vendor): no resolution", async () => {
    const conflict = stayConflict(
      { id: "standard-1" },
      { id: "public-1", title: "Stay at PUBLIC Hotel New York" },
    );
    const deps = fakeDeps({
      idsForQuery: (query) => (query.includes("The Standard") ? ["msg-1"] : []),
      mailFor: {
        "msg-1": mail({
          subject: "Your reservation at The Standard has been cancelled",
          // A real cancellation, but for 12 Sept — a different booking at the same hotel.
          // conflict-evidence.test.ts already shows this is only ever "weak".
          bodyText: "Your stay from 12 Sept 2026 has been cancelled as requested.",
        }),
      },
    });
    const [resolved] = await resolveConflicts([conflict], deps);
    expect(resolved!.resolution).toBeUndefined();
  });
});

describe("resolveConflicts — the caps", () => {
  it("a double-booked clash is never searched", async () => {
    const deps = fakeDeps({ idsForQuery: () => ["msg-1"] });
    const [resolved] = await resolveConflicts([doubleBooked()], deps);
    expect(resolved!.resolution).toBeUndefined();
    expect(deps.calls).toHaveLength(0);
  });

  it("a fourth clash is never searched — MAX_CLASHES_PER_PASS caps clashes per pass", async () => {
    const clashes = Array.from({ length: 4 }, (_, i) =>
      stayConflict({ id: `a${i}` }, { id: `b${i}`, title: `Stay at Vendor${i} Hotel` }));
    const deps = fakeDeps({ idsForQuery: () => [] });
    await resolveConflicts(clashes, deps);
    // 2 events per clash × 3 searched clashes; the 4th clash's own 2 events never fire a search.
    expect(deps.calls).toHaveLength(MAX_CLASHES_PER_PASS * 2);
    expect(deps.calls.every((c) => !c.query.includes("Vendor3"))).toBe(true);
  });

  it("a sixth message is never read — MAX_MESSAGES_PER_EVENT caps reads per event", async () => {
    const conflict = stayConflict({ id: "standard-1" }, { id: "public-1", title: "Stay at PUBLIC Hotel New York" });
    const sixIds = Array.from({ length: 6 }, (_, i) => `msg-${i}`);
    const deps = fakeDeps({ idsForQuery: (query) => (query.includes("The Standard") ? sixIds : []) });
    await resolveConflicts([conflict], deps);
    const readOfThose = deps.reads.filter((id) => sixIds.includes(id));
    expect(readOfThose).toHaveLength(MAX_MESSAGES_PER_EVENT);
    expect(readOfThose).not.toContain("msg-5");
  });

  it("a search error leaves the conflict unchanged (same reference), with one console.warn", async () => {
    const conflict = stayConflict({ id: "standard-1" }, { id: "public-1", title: "Stay at PUBLIC Hotel New York" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps: ConflictResolutionDeps = {
      gmailFor: async () => ({
        search: async () => { throw new Error("rate limited"); },
        read: async () => null,
      }),
    };
    const [resolved] = await resolveConflicts([conflict], deps);
    expect(resolved).toBe(conflict);
    expect(resolved!.resolution).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("never throws, whatever deps.gmailFor itself does", async () => {
    const conflict = stayConflict({ id: "standard-1" }, { id: "public-1", title: "Stay at PUBLIC Hotel New York" });
    const deps: ConflictResolutionDeps = { gmailFor: async () => { throw new Error("no token"); } };
    await expect(resolveConflicts([conflict], deps)).resolves.toEqual([conflict]);
  });
});

describe("mail text can never choose which event, or invent a clash the detector did not raise", () => {
  it("a mail naming an unrelated event cannot create a resolution for either candidate", async () => {
    const conflict = stayConflict({ id: "standard-1" }, { id: "public-1", title: "Stay at PUBLIC Hotel New York" });
    const deps = fakeDeps({
      idsForQuery: () => ["msg-1"],
      mailFor: {
        "msg-1": mail({
          subject: "Cancel the 14:00 with the bank",
          bodyText: "Please cancel the 14:00 meeting with the bank today.",
        }),
      },
    });
    const [resolved] = await resolveConflicts([conflict], deps);
    expect(resolved!.resolution).toBeUndefined();
  });

  it("resolveConflicts only ever walks the clashes it was given — it cannot invent one", async () => {
    const deps = fakeDeps({
      idsForQuery: () => ["msg-1"],
      mailFor: { "msg-1": mail({ subject: "Cancel the 14:00 with the bank" }) },
    });
    const onlyDoubleBooked = [doubleBooked()];
    const out = await resolveConflicts(onlyDoubleBooked, deps);
    expect(out).toEqual(onlyDoubleBooked);
    expect(deps.calls).toHaveLength(0);
  });

  it("a resolution's staleEventId is always one of the clash's own event ids from calendar data, never text parsed out of a mail", async () => {
    const conflict = stayConflict({ id: "standard-1" }, { id: "public-1", title: "Stay at PUBLIC Hotel New York" });
    const deps = fakeDeps({
      idsForQuery: (q) => (q.includes("The Standard") ? ["msg-1"] : []),
      mailFor: {
        "msg-1": mail({
          // The mail body NAMES a different id — the code must never read it.
          subject: "Your reservation at The Standard has been cancelled, also cancel event xyz-999",
          bodyText: "Cancelled for 26 Aug 2026.",
        }),
      },
    });
    const [resolved] = await resolveConflicts([conflict], deps);
    expect(resolved!.resolution!.staleEventId).toBe("standard-1");
    expect(resolved!.resolution!.staleEventId).not.toBe("xyz-999");
  });
});

describe("resolveConflicts — event identity carries through when s1 set it, omitted when it did not", () => {
  it("omits account/calendarId on the resolution when the source event carries neither", async () => {
    const conflict = stayConflict({ id: "standard-1" }, { id: "public-1", title: "Stay at PUBLIC Hotel New York" });
    const deps = fakeDeps({
      idsForQuery: (query) => (query.includes("The Standard") ? ["msg-1"] : []),
      mailFor: { "msg-1": mail({ subject: "Your reservation at The Standard has been cancelled", bodyText: "Cancelled for 26 Aug 2026." }) },
    });
    const [resolved] = await resolveConflicts([conflict], deps);
    expect(resolved!.resolution).not.toHaveProperty("account");
    expect(resolved!.resolution).not.toHaveProperty("calendarId");
  });

  it("searches the event's own account, or the default mailbox when absent", async () => {
    const conflict = stayConflict(
      { id: "standard-1", account: "second@example.invalid" },
      { id: "public-1", title: "Stay at PUBLIC Hotel New York" },
    );
    const deps = fakeDeps({ idsForQuery: () => [] });
    await resolveConflicts([conflict], deps);
    const accountsAsked = deps.calls.map((c) => c.account);
    expect(accountsAsked).toContain("second@example.invalid");
    expect(accountsAsked).toContain(undefined);
  });
});
