import { describe, it, expect, vi } from "vitest";
import { runAttendeeSync, type AttendeeSyncDeps } from "../lib/run.js";
import {
  DEFAULT_STARVATION_STREAK, DEFAULT_STARVATION_WINDOW_DAYS,
  type CalEvent, type MeetingRow,
} from "../lib/attendees.js";

const NOW = new Date("2026-08-03T09:00:00.000Z");
const OPTS = {
  selfEmails: ["owner@example.com"],
  toleranceMinutes: 90,
  createdToleranceMinutes: 90,
  windowDays: 400,
  now: NOW,
  dryRun: false,
  starvationStreak: DEFAULT_STARVATION_STREAK,
  starvationWindowDays: DEFAULT_STARVATION_WINDOW_DAYS,
};

function deps(rows: MeetingRow[], events: CalEvent[], failOn?: string) {
  const updated: Array<{ pageId: string; value: string; startsAt?: string }> = [];
  const synced: string[] = [];
  const flagged: Array<{ pageId: string; reason: string }> = [];
  const errors: Array<{ pageId: string; message: string }> = [];
  const windows: Array<{ timeMin: string; timeMax: string }> = [];
  const notified: string[] = [];
  const statusUpdated: Array<{ pageId: string; name: string; type: "status" | "select" }> = [];
  const impl: AttendeeSyncDeps = {
    listMeetings: async () => rows,
    listEvents: async (w) => { windows.push(w); return events; },
    updateMeetingMatch: async (pageId, value) => {
      if (pageId === failOn) throw new Error("notion PATCH failed: 500");
      updated.push({
        pageId, value: value.attendees,
        ...(value.startsAt === undefined ? {} : { startsAt: value.startsAt }),
      });
    },
    updateMeetingStatus: async (pageId, value) => {
      if (pageId === failOn) throw new Error("notion PATCH failed: 500");
      statusUpdated.push({ pageId, ...value });
    },
    recordSynced: async (pageId) => { synced.push(pageId); },
    recordUnmatched: async (pageId, reason) => { flagged.push({ pageId, reason }); },
    recordError: async (pageId, message) => { errors.push({ pageId, message }); },
    notify: async (message) => { notified.push(message); },
  };
  return { impl, updated, synced, flagged, errors, windows, notified, statusUpdated };
}

const row: MeetingRow = {
  pageId: "page-1", matchTitle: "Alex // Bendik",
  startsAt: "2026-06-02T10:30:00.000Z", startsAtSource: "date-property",
  dateHasTime: true, createdAt: "2026-06-02T10:28:00.000Z", attendees: "",
  hasSummary: false, status: "Recorded", statusType: "status",
};
const event: CalEvent = {
  id: "evt-1", summary: "Alex // Bendik", start: "2026-06-02T10:30:00.000Z",
  attendees: [{ email: "alex@partner.example", displayName: "Alex Partner" }],
};

describe("runAttendeeSync", () => {
  it("writes matched attendees and records them synced", async () => {
    const d = deps([row], [event]);
    const res = await runAttendeeSync(OPTS, d.impl);

    expect(d.updated).toEqual([{ pageId: "page-1", value: "Alex Partner <alex@partner.example>" }]);
    expect(d.synced).toEqual(["page-1"]);
    expect(d.flagged).toEqual([]);
    expect(res).toMatchObject({ scanned: 1, filled: 1, flagged: 0 });
  });

  it("records unmatched rows without writing to Notion", async () => {
    const d = deps([{ ...row, startsAt: null }], [event]);
    const res = await runAttendeeSync(OPTS, d.impl);

    expect(d.updated).toEqual([]);
    expect(d.flagged).toEqual([{ pageId: "page-1", reason: "no-date" }]);
    expect(res.flagged).toBe(1);
  });

  it("writes nothing at all in dry-run but still reports the plan", async () => {
    const d = deps([row], [event]);
    const res = await runAttendeeSync({ ...OPTS, dryRun: true }, d.impl);

    expect(d.updated).toEqual([]);
    expect(d.synced).toEqual([]);
    expect(d.flagged).toEqual([]);
    expect(res.filled).toBe(1);
    expect(res.summary).toContain("dry-run");
  });

  it("reports zero bookkeeping failures in the summary on a clean run", async () => {
    const d = deps([row], [event]);
    const res = await runAttendeeSync(OPTS, d.impl);

    expect(res.bookkeepingFailed).toBe(0);
    expect(res.summary).toContain("0 bookkeeping-failed");
  });

  it("requests a calendar window of windowDays back and one day forward", async () => {
    const d = deps([row], [event]);
    await runAttendeeSync({ ...OPTS, windowDays: 10 }, d.impl);

    expect(d.windows).toEqual([{
      timeMin: "2026-07-24T09:00:00.000Z",
      timeMax: "2026-08-04T09:00:00.000Z",
    }]);
  });

  it("records a failed write and keeps going instead of aborting the run", async () => {
    const second: MeetingRow = { ...row, pageId: "page-2" };
    const d = deps([row, second], [event], "page-1");
    const res = await runAttendeeSync(OPTS, d.impl);

    expect(d.errors).toEqual([{ pageId: "page-1", message: "notion PATCH failed: 500" }]);
    expect(d.updated.map((u) => u.pageId)).toEqual(["page-2"]);
    expect(d.synced).toEqual(["page-2"]);
    expect(res).toMatchObject({ filled: 1, errored: 1 });
  });

  it("throws when the calendar returns no events but there are meeting rows to match", async () => {
    const d = deps([row], []);

    await expect(runAttendeeSync(OPTS, d.impl)).rejects.toThrow(/0 events/);
    // Nothing was written or flagged before the throw — a misconfigured
    // principal/org/tolerance must not sweep every row into `unmatched`.
    expect(d.updated).toEqual([]);
    expect(d.flagged).toEqual([]);
    expect(d.errors).toEqual([]);
  });

  it("does not throw on an empty calendar when there is nothing to match", async () => {
    const d = deps([], []);
    const res = await runAttendeeSync(OPTS, d.impl);
    expect(res).toMatchObject({ scanned: 0, filled: 0, flagged: 0, errored: 0 });
  });

  it("does not throw on an empty calendar when every scanned row is already filled", async () => {
    // Steady state: rows exist but none need matching, so an empty calendar puts
    // nothing at risk. Keying the guard on scanned rows would hard-fail here.
    const done: MeetingRow = { ...row, attendees: "Someone <x@y.z>" };
    const d = deps([done, { ...done, pageId: "page-2" }], []);

    const res = await runAttendeeSync(OPTS, d.impl);

    expect(res).toMatchObject({ scanned: 2, filled: 0, flagged: 0, errored: 0 });
    expect(d.updated).toEqual([]);
  });

  it("still throws on an empty calendar when even one scanned row needs matching", async () => {
    const done: MeetingRow = { ...row, pageId: "page-2", attendees: "Someone <x@y.z>" };
    const d = deps([done, row], []);

    await expect(runAttendeeSync(OPTS, d.impl)).rejects.toThrow(
      /calendar returned 0 events for a window with 1 meeting row\(s\)/,
    );
  });

  it("keeps going when recordSynced throws, without misreporting it as a Notion failure", async () => {
    const second: MeetingRow = { ...row, pageId: "page-2" };
    const updated: Array<{ pageId: string; value: string }> = [];
    const synced: string[] = [];
    const errors: Array<{ pageId: string; message: string }> = [];
    const impl: AttendeeSyncDeps = {
      listMeetings: async () => [row, second],
      listEvents: async () => [event],
      updateMeetingMatch: async (pageId, value) => { updated.push({ pageId, value: value.attendees }); },
      // ORB-27's status advance runs only for rows where `hasSummary && status !== "Summarized"`
      // (lib/run.ts:221). Every row in this describe block is built from `row`, whose `hasSummary`
      // is false — so this dep must never fire, and saying so is worth more than a no-op: it pins
      // the gate here too, and a future change that starts advancing status in an error-containment
      // test fails loudly instead of passing quietly. Same stub in the three impls below.
      updateMeetingStatus: async () => { throw new Error("must not be called"); },
      recordSynced: async (pageId) => {
        if (pageId === "page-1") throw new Error("store unreachable");
        synced.push(pageId);
      },
      recordUnmatched: async () => {},
      recordError: async (pageId, message) => { errors.push({ pageId, message }); },
      notify: async () => {},
    };

    const res = await runAttendeeSync(OPTS, impl);

    // Both Notion writes happened...
    expect(updated.map((u) => u.pageId)).toEqual(["page-1", "page-2"]);
    // ...but page-1's bookkeeping write failed and was contained, not reported
    // through recordError (Notion succeeded — that would be a lie).
    expect(synced).toEqual(["page-2"]);
    expect(errors).toEqual([]);
    // Both count as filled: the Notion write is what "filled" tracks.
    expect(res).toMatchObject({ filled: 2, errored: 0, bookkeepingFailed: 1 });
    expect(res.summary).toContain("1 bookkeeping-failed");
  });

  it("logs the page id and the error message for every bookkeeping failure", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      const impl: AttendeeSyncDeps = {
        listMeetings: async () => [row],
        listEvents: async () => [event],
        updateMeetingMatch: async () => {},
        updateMeetingStatus: async () => { throw new Error("must not be called"); },
        recordSynced: async () => { throw new Error("store unreachable"); },
        recordUnmatched: async () => {},
        recordError: async () => {},
        notify: async () => {},
      };

      await runAttendeeSync(OPTS, impl);
    } finally {
      spy.mockRestore();
    }

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("page-1");
    expect(logged[0]).toContain("store unreachable");
  });

  it("keeps going when both the Notion write and its error bookkeeping throw", async () => {
    const second: MeetingRow = { ...row, pageId: "page-2" };
    const updated: Array<{ pageId: string; value: string }> = [];
    const synced: string[] = [];
    const impl: AttendeeSyncDeps = {
      listMeetings: async () => [row, second],
      listEvents: async () => [event],
      updateMeetingMatch: async (pageId, value) => {
        if (pageId === "page-1") throw new Error("notion PATCH failed: 500");
        updated.push({ pageId, value: value.attendees });
      },
      updateMeetingStatus: async () => { throw new Error("must not be called"); },
      recordSynced: async (pageId) => { synced.push(pageId); },
      recordUnmatched: async () => {},
      recordError: async () => { throw new Error("store unreachable"); },
      notify: async () => {},
    };

    // The run must resolve, not reject, even though recordError itself throws.
    const res = await runAttendeeSync(OPTS, impl);

    expect(updated.map((u) => u.pageId)).toEqual(["page-2"]);
    expect(synced).toEqual(["page-2"]);
    expect(res).toMatchObject({ filled: 1, errored: 1, bookkeepingFailed: 1 });
  });

  it("keeps going when recordUnmatched throws for one row but not the next", async () => {
    const rowA: MeetingRow = { ...row, pageId: "page-1", startsAt: null };
    const rowB: MeetingRow = { ...row, pageId: "page-2", startsAt: null };
    const flagged: string[] = [];
    const impl: AttendeeSyncDeps = {
      listMeetings: async () => [rowA, rowB],
      listEvents: async () => [event],
      updateMeetingMatch: async () => { throw new Error("must not be called"); },
      updateMeetingStatus: async () => { throw new Error("must not be called"); },
      recordSynced: async () => { throw new Error("must not be called"); },
      recordUnmatched: async (pageId) => {
        if (pageId === "page-1") throw new Error("store unreachable");
        flagged.push(pageId);
      },
      recordError: async () => { throw new Error("must not be called"); },
      notify: async () => {},
    };

    const res = await runAttendeeSync(OPTS, impl);

    expect(flagged).toEqual(["page-2"]);
    expect(res.flagged).toBe(2);
    // page-1's flag never reached the store — counted, not silently dropped.
    expect(res.bookkeepingFailed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ORB-155
// ─────────────────────────────────────────────────────────────────────────────

describe("runAttendeeSync — the Date write-back (ORB-155)", () => {
  it("sends attendees and the event's datetime in one write", async () => {
    const undated: MeetingRow = {
      ...row, startsAtSource: "title-mention", dateHasTime: false,
    };
    const d = deps([undated], [event]);
    await runAttendeeSync(OPTS, d.impl);

    expect(d.updated).toEqual([{
      pageId: "page-1",
      value: "Alex Partner <alex@partner.example>",
      startsAt: "2026-06-02T10:30:00.000Z",
    }]);
    expect(d.synced).toEqual(["page-1"]);
  });

  it("leaves an existing datetime alone", async () => {
    const d = deps([row], [event]);
    await runAttendeeSync(OPTS, d.impl);
    expect(d.updated).toEqual([{ pageId: "page-1", value: "Alex Partner <alex@partner.example>" }]);
  });
});

describe("runAttendeeSync — the starvation alert (ORB-155)", () => {
  /** A note created `n` days before NOW that no event can match. */
  const orphan = (pageId: string, days: number): MeetingRow => ({
    ...row,
    pageId,
    matchTitle: pageId,
    createdAt: new Date(NOW.getTime() - days * 86_400_000).toISOString(),
    startsAt: new Date(NOW.getTime() - days * 86_400_000).toISOString(),
    startsAtSource: "created-time",
    dateHasTime: false,
  });

  it("stays silent for a single ad-hoc note with no calendar event", async () => {
    const d = deps([row, orphan("ad-hoc", 1)], [event]);
    await runAttendeeSync(OPTS, d.impl);
    expect(d.notified).toEqual([]);
  });

  it("pings once — not per row — when the last three notes have all failed", async () => {
    const d = deps([row, orphan("a", 3), orphan("b", 2), orphan("c", 1)], [event]);
    const res = await runAttendeeSync(OPTS, d.impl);

    expect(d.notified).toHaveLength(1);
    expect(d.notified[0]).toContain("3 most recent");
    expect(d.notified[0]).toContain("c");
    expect(res.starved).toBe(true);
  });

  it("says nothing in dry-run — a rehearsal must not ping a human", async () => {
    const d = deps([row, orphan("a", 3), orphan("b", 2), orphan("c", 1)], [event]);
    await runAttendeeSync({ ...OPTS, dryRun: true }, d.impl);
    expect(d.notified).toEqual([]);
  });

  it("never lets a failing spine fail the run or lose the rows it already filled", async () => {
    const d = deps([row, orphan("a", 3), orphan("b", 2), orphan("c", 1)], [event]);
    const impl = { ...d.impl, notify: async () => { throw new Error("spine down"); } };
    const res = await runAttendeeSync(OPTS, impl);
    expect(res.filled).toBe(1);
    expect(res.starved).toBe(true);
  });
});


// ─── ORB-27 — the status pass ──────────────────────────────────────────────────────────────
describe("runAttendeeSync — Status auto-advance (ORB-27)", () => {
  const summarized: MeetingRow = { ...row, hasSummary: true, status: "Recorded" };

  it("a row with a summary advances to Summarized, carrying the property TYPE it was read with", async () => {
    const d = deps([{ ...summarized, statusType: "select" }], [event]);
    const res = await runAttendeeSync(OPTS, d.impl);
    expect(d.statusUpdated).toEqual([{ pageId: "page-1", name: "Summarized", type: "select" }]);
    expect(res.statusAdvanced).toBe(1);
    expect(res.statusFailed).toBe(0);
  });

  it("already-Summarized and summary-less rows are untouched — the pass is idempotent by its guard", async () => {
    const d = deps([
      { ...summarized, pageId: "done", status: "Summarized" },
      { ...row, pageId: "nosummary", hasSummary: false },
    ], [event]);
    const res = await runAttendeeSync(OPTS, d.impl);
    expect(d.statusUpdated).toEqual([]);
    expect(res.statusAdvanced).toBe(0);
  });

  it("a status write failure is counted, logged, and NEVER touches the attendee half's errored count", async () => {
    const d = deps([summarized], [event], "page-1");
    const res = await runAttendeeSync(OPTS, d.impl);
    // failOn breaks BOTH writes for page-1: the match error counts in errored (pre-existing
    // contract), the status error only in statusFailed — the two halves stay separate.
    expect(res.statusFailed).toBe(1);
    expect(res.statusAdvanced).toBe(0);
  });

  it("dry-run advances nothing", async () => {
    const d = deps([summarized], [event]);
    const res = await runAttendeeSync({ ...OPTS, dryRun: true }, d.impl);
    expect(d.statusUpdated).toEqual([]);
    expect(res.statusAdvanced).toBe(0);
  });
});
