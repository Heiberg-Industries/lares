import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";
import {
  FOLLOWUP_MAX_AGE_DAYS,
  FOLLOWUP_MAX_FUTURE_SLACK_MINUTES,
  MARKDOWN_READ_CEILING,
  withinFollowupAge,
  liveListMeetings,
  makeFollowupTick,
  type FollowupDeps,
  type MeetingRow,
} from "../agent/schedules/meeting-followup.js";

/**
 * ORB-156-INCIDENT (2026-08-24): with no recency bound, `liveListMeetings`'s trigger — "Summary
 * non-empty AND Attendees non-empty AND no send-log row" — was true of every meeting the
 * database had ever held, and the schedule started composing follow-ups for meetings up to a
 * year old, oldest-first, before it was caught and contained by hand. `FOLLOWUP_MAX_AGE_DAYS`
 * and `withinFollowupAge` are the code fix; this file is the test coverage that should have
 * existed before the deploy that caused it (see `liveListMeetings`'s own header: it was
 * "currently module-private and untested").
 */

const NOW = new Date("2026-08-24T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
const minutesFromNow = (minutes: number) => new Date(NOW.getTime() + minutes * 60 * 1000).toISOString();
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

describe("withinFollowupAge (FOLLOWUP_MAX_AGE_DAYS) — pure recency gate", () => {
  it("FOLLOWUP_MAX_AGE_DAYS is 2 days", () => {
    expect(FOLLOWUP_MAX_AGE_DAYS).toBe(2);
  });

  it("excludes a meeting that started 400 days ago", () => {
    const rows = [{ pageId: "ancient", startsAt: daysAgo(400) }];
    expect(withinFollowupAge(rows, NOW)).toEqual([]);
  });

  it("excludes a meeting that started 3 days ago — just outside the bound", () => {
    const rows = [{ pageId: "3-days", startsAt: daysAgo(3) }];
    expect(withinFollowupAge(rows, NOW)).toEqual([]);
  });

  it("includes a meeting that started 1 hour ago", () => {
    const rows = [{ pageId: "1-hour", startsAt: hoursAgo(1) }];
    expect(withinFollowupAge(rows, NOW)).toEqual(rows);
  });

  it("excludes a row with no usable start time — fails CLOSED, not open", () => {
    const rows = [
      { pageId: "no-date", startsAt: undefined },
      { pageId: "garbage-date", startsAt: "not-a-real-date" },
    ];
    expect(withinFollowupAge(rows, NOW)).toEqual([]);
  });

  it("keeps recent rows and drops ancient ones from a mixed batch", () => {
    const rows = [
      { pageId: "old-1", startsAt: daysAgo(400) },
      { pageId: "recent-1", startsAt: hoursAgo(1) },
      { pageId: "old-2", startsAt: daysAgo(30) },
      { pageId: "recent-2", startsAt: daysAgo(1) },
      { pageId: "undated", startsAt: undefined },
    ];
    expect(withinFollowupAge(rows, NOW).map((r) => r.pageId)).toEqual(["recent-1", "recent-2"]);
  });
});

describe("withinFollowupAge (FOLLOWUP_MAX_FUTURE_SLACK_MINUTES) — the other end of the bound", () => {
  // Post-fix review (Important): the original version only checked "not too old" — the
  // identical fail-open shape the incident is about, just facing the other way. A future or
  // fat-fingered `Date` (year 3025, a typo'd year) would otherwise be permanently eligible and
  // composed every tick forever, since it never ages INTO the window from the future side.

  it("FOLLOWUP_MAX_FUTURE_SLACK_MINUTES is 30 minutes", () => {
    expect(FOLLOWUP_MAX_FUTURE_SLACK_MINUTES).toBe(30);
  });

  it("excludes a meeting dated a year in the future", () => {
    const rows = [{ pageId: "future-typo", startsAt: daysFromNow(365) }];
    expect(withinFollowupAge(rows, NOW)).toEqual([]);
  });

  it("still includes a meeting starting 5 minutes from now — legitimate slack, not a typo", () => {
    const rows = [{ pageId: "starting-soon", startsAt: minutesFromNow(5) }];
    expect(withinFollowupAge(rows, NOW)).toEqual(rows);
  });

  it("excludes a meeting starting well beyond the forward slack (2 hours from now)", () => {
    const rows = [{ pageId: "too-far-future", startsAt: minutesFromNow(120) }];
    expect(withinFollowupAge(rows, NOW)).toEqual([]);
  });
});

// ─── Integration: the bound is applied BEFORE MARKDOWN_READ_CEILING ───────────────────────────

function meetingNotesMarkdown(label: string): string {
  return `<meeting-notes>\n<summary>\nRecap: ${label}\n</summary>\n</meeting-notes>`;
}

// More ancient candidates than MARKDOWN_READ_CEILING (15), all otherwise fully ready
// (Summary + Attendees filled, no send-log row) and all older than every recent row, so
// oldest-first ordering alone would let them crowd out the read ceiling entirely if the
// recency bound were not applied first.
const ANCIENT_COUNT = MARKDOWN_READ_CEILING + 5;
const ancientPages = Array.from({ length: ANCIENT_COUNT }, (_, i) => ({
  id: `page-ancient-${i}`,
  created_time: daysAgo(400),
  properties: {
    "Date": { date: { start: daysAgo(400 - i) } }, // all still far outside the 2-day bound
    "Meeting Title": { title: [{ plain_text: `Ancient Meeting ${i}` }] },
    "Series": { rich_text: [] },
    "Attendees": { rich_text: [{ plain_text: "Stefan <sam@example.com>" }] },
    "Action Items": { rich_text: [] },
    "Summary": { rich_text: [{ plain_text: "A dense property summary." }] },
  },
}));

const recentPages = [
  {
    id: "page-recent-1",
    created_time: hoursAgo(1),
    properties: {
      "Date": { date: { start: hoursAgo(1) } },
      "Meeting Title": { title: [{ plain_text: "Recent Meeting 1" }] },
      "Series": { rich_text: [] },
      "Attendees": { rich_text: [{ plain_text: "Stefan <sam@example.com>" }] },
      "Action Items": { rich_text: [] },
      "Summary": { rich_text: [{ plain_text: "A dense property summary." }] },
    },
  },
  {
    id: "page-recent-2",
    created_time: daysAgo(1),
    properties: {
      "Date": { date: { start: daysAgo(1) } },
      "Meeting Title": { title: [{ plain_text: "Recent Meeting 2" }] },
      "Series": { rich_text: [] },
      "Attendees": { rich_text: [{ plain_text: "Stefan <sam@example.com>" }] },
      "Action Items": { rich_text: [] },
      "Summary": { rich_text: [{ plain_text: "A dense property summary." }] },
    },
  },
];

function fakeNotionFetch(readPageIds: string[]) {
  return vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/query")) {
      return new Response(
        JSON.stringify({ results: [...ancientPages, ...recentPages], has_more: false, next_cursor: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const markdownMatch = /\/v1\/pages\/([^/]+)\/markdown/.exec(url);
    if (method === "GET" && markdownMatch) {
      const pageId = markdownMatch[1]!;
      readPageIds.push(pageId);
      return new Response(
        JSON.stringify({ markdown: meetingNotesMarkdown(pageId) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  });
}

// No send-log rows at all — every candidate above is otherwise eligible, so the recency bound
// is the ONLY thing standing between the ancient rows and a markdown read / compose slot.
const fakePool = { query: async () => ({ rows: [] }) } as unknown as Pool;

describe("liveListMeetings — FOLLOWUP_MAX_AGE_DAYS applied before MARKDOWN_READ_CEILING", () => {
  beforeEach(() => {
    process.env["NOTION_TOKEN"] = "test-token";
    delete process.env["EGRESS_PROXY_URL"];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["NOTION_TOKEN"];
  });

  it("never reads or returns an ancient row, even though ancient rows outnumber MARKDOWN_READ_CEILING and sort first", async () => {
    const readPageIds: string[] = [];
    vi.stubGlobal("fetch", fakeNotionFetch(readPageIds));

    const result = await liveListMeetings(fakePool, NOW);

    // The point of the ordering fix: ancient rows never even cost a Notion page read.
    // Oldest-first: page-recent-2 (1 day ago) sorts ahead of page-recent-1 (1 hour ago).
    expect(readPageIds).toEqual(["page-recent-2", "page-recent-1"]);
    expect(readPageIds.some((id) => id.startsWith("page-ancient-"))).toBe(false);

    // And only the recent meetings come back as ready follow-up candidates.
    expect(result.map((r) => r.pageId).sort()).toEqual(["page-recent-1", "page-recent-2"]);
  });
});

// ─── makeFollowupTick defends itself — never trusts an injected listMeetings ───────────────────

// Post-fix review (Important): the age gate must not live ONLY in `liveListMeetings`. Any
// injected `listMeetings` — a test double, a future second call site — must not be able to
// reopen the 2026-08-24 incident by skipping `liveListMeetings`'s own recency check. This
// double never claims/composes/sends anything unless the engine's own gate lets a row through.
function meetingRow(over: Partial<MeetingRow> = {}): MeetingRow {
  return {
    pageId: "page-1",
    title: "Ancient Meeting",
    startsAt: daysAgo(400),
    series: "",
    attendees: "Stefan <sam@example.com>",
    summaryBlock: "### Recap\n- did stuff",
    actionItems: "",
    ...over,
  };
}

function tickDeps(over: Partial<FollowupDeps> = {}): FollowupDeps {
  return {
    listMeetings: async () => [meetingRow()],
    claim: async () => ({ claimed: true, attempt: 1, isFinalAttempt: false }),
    compose: async () => { throw new Error("compose must not be called for an ancient row"); },
    send: async () => { throw new Error("send must not be called for an ancient row"); },
    getOutcome: async () => null,
    recordOutcome: async () => {},
    notify: async () => {},
    reportAutonomousSendFailed: async () => {},
    reportDropped: async () => {},
    selfEmails: ["owner@owner.example"],
    ...over,
  };
}

describe("makeFollowupTick — defends itself against an ancient row from its own listMeetings dep", () => {
  it("composes nothing for a meeting the injected listMeetings returns that started 400 days ago", async () => {
    let claimCalls = 0;
    const deps = tickDeps({
      listMeetings: async () => [meetingRow({ pageId: "ancient-1", startsAt: daysAgo(400) })],
      claim: async () => { claimCalls += 1; return { claimed: true, attempt: 1, isFinalAttempt: false }; },
    });

    const result = await makeFollowupTick(deps).tick(NOW);

    expect(result.scanned).toBe(1);
    expect(result.composed).toBe(0);
    expect(result.queued).toBe(0);
    expect(result.errored).toBe(0);
    // Post-fix review (Minor, not deferred): a row dropped for age must be COUNTED, never
    // merely absent — scanned=1/composed=0 with no reason is the exact silent-failure shape
    // this whole chain of fixes exists to end.
    expect(result.agedOut).toBe(1);
    // Never even claimed — same reasoning as an unready row: an ancient row must not spend one
    // of its three claim attempts on being excluded by the engine's own recency gate.
    expect(claimCalls).toBe(0);
  });

  it("still composes a recent, ready meeting from the same injected listMeetings", async () => {
    const composed: string[] = [];
    const deps = tickDeps({
      listMeetings: async () => [meetingRow({ pageId: "recent-1", startsAt: hoursAgo(1) })],
      compose: async (row) => { composed.push(row.pageId); return { subject: "Recap", bodyText: "Body" }; },
      send: async () => ({ autonomous: false }),
    });

    const result = await makeFollowupTick(deps).tick(NOW);

    expect(composed).toEqual(["recent-1"]);
    expect(result.composed).toBe(1);
    expect(result.agedOut).toBe(0);
  });

  it("counts and LOGS the age-exclusion, naming the count, so it is never silent", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const deps = tickDeps({
        listMeetings: async () => [
          meetingRow({ pageId: "ancient-1", startsAt: daysAgo(400) }),
          meetingRow({ pageId: "ancient-2", startsAt: daysAgo(30) }),
          meetingRow({ pageId: "recent-1", startsAt: hoursAgo(1) }),
        ],
        compose: async () => ({ subject: "Recap", bodyText: "Body" }),
        send: async () => ({ autonomous: false }),
      });

      const result = await makeFollowupTick(deps).tick(NOW);

      expect(result.agedOut).toBe(2);
      expect(result.composed).toBe(1); // only the recent one
      const warnedAboutAge = warnSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("excluded 2 row(s)") && call[0].includes("meeting-followup"),
      );
      expect(warnedAboutAge).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
