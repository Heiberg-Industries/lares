import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";

/**
 * LAR-28 — `liveListMeetings`'s stage-1 properties-only pre-filter used to exclude a `queued`
 * page as TERMINAL, exactly like `sent`/`skipped` (ORB-156 fix round 2). That made the acceptance
 * criterion this ticket ships impossible to reach live: `claimMeeting`'s hash-diff reclaim
 * (lib/meeting-followup-store.ts) can only compare against the page's CURRENT summary hash, and a
 * page excluded at stage 1 never gets its markdown read again — its hash would never be
 * recomputed, so a `queued` row could never actually be reclaimed outside a test calling
 * `claimMeeting` directly. `denied` was never in the old exclusion list at all (it did not exist
 * before this ticket), so only `queued`'s exclusion needed to be lifted; `sent`/`skipped` remain
 * genuinely terminal.
 *
 * A SEPARATE FILE, deliberately: `agent/schedules/meeting-followup.ts`'s `notionFetch()` caches
 * its resolved fetch dispatcher in a MODULE-SCOPE variable ("Built once, lazily... then reused for
 * every Notion call this schedule ever makes" — that file's own comment), which is never
 * invalidated by `vi.unstubAllGlobals()`. Sharing a file with `meeting-followup-live-list.test.ts`
 * would let ITS fetch mock (from the FIRST test that ever calls `liveListMeetings` in this
 * process) leak into every later test's `pool`/`fetch` pair once ES module caching applies,
 * `vi.resetModules()` notwithstanding for a lazily-memoized module-scope promise. One file, one
 * dynamic import, one fetch mock — the same isolation the existing file already relies on by
 * having exactly one describe block.
 */

const READY_PAGE = {
  id: "page-ready-1",
  created_time: "2026-08-20T09:00:00.000Z",
  properties: {
    "Date": { date: { start: "2026-08-20T09:00:00.000Z" } },
    "Meeting Title": { title: [{ plain_text: "Ready Page" }] },
    "Series": { rich_text: [] },
    "Attendees": { rich_text: [{ plain_text: "Stefan <sam@example.com>" }] },
    "Action Items": { rich_text: [] },
    "Summary": { rich_text: [{ plain_text: "A dense one-paragraph property summary." }] },
  },
};

const NOW = new Date("2026-08-20T10:00:00.000Z");

function fakeReadyNotionFetch() {
  return vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/query")) {
      return new Response(
        JSON.stringify({ results: [READY_PAGE], has_more: false, next_cursor: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "GET" && url.includes("/markdown")) {
      return new Response(
        JSON.stringify({ markdown: "<meeting-notes><summary>Fresh recap text.</summary></meeting-notes>" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  });
}

describe("liveListMeetings — a queued row is still re-read for its live hash (LAR-28)", () => {
  beforeEach(() => {
    process.env["NOTION_TOKEN"] = "test-token";
    delete process.env["EGRESS_PROXY_URL"];
    vi.stubGlobal("fetch", fakeReadyNotionFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["NOTION_TOKEN"];
  });

  it("does not exclude a 'queued' page — its live summary hash must be re-checked", async () => {
    const { liveListMeetings } = await import("../agent/schedules/meeting-followup.js");
    const pool = {
      // Proves the SQL itself, not merely a fake, does the excluding: a doneRows query that
      // still matched `queued` would return this page's id here and the result would be [].
      query: async () => ({ rows: [] as Array<{ notion_page_id: string }> }),
    } as unknown as Pool;

    const result = await liveListMeetings(pool, NOW);
    expect(result.map((r) => r.pageId)).toEqual(["page-ready-1"]);
  });

  it("still excludes a page whose doneRows query reports it 'sent' — that terminal truth is untouched", async () => {
    const { liveListMeetings } = await import("../agent/schedules/meeting-followup.js");
    const pool = {
      query: async (sqlText: string) => ({
        rows: sqlText.includes("notion_page_id FROM meeting_followup_sent")
          ? [{ notion_page_id: "page-ready-1" }]
          : [],
      }),
    } as unknown as Pool;

    const result = await liveListMeetings(pool, NOW);
    expect(result).toEqual([]);
  });
});
