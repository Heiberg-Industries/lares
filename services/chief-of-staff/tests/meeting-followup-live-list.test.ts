import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";

/**
 * Finding 5 (Important) — the summary-mismatch signal has no dedupe. `liveListMeetings` runs
 * every 5 minutes; without a dedupe, one persistently-broken page (Summary property filled,
 * but no `<summary>` block ever extractable) would emit that signal roughly 288 times a day,
 * forever — an agent in this fleet was already paused for exactly that kind of spam.
 *
 * `emitSignal` (lib/signal-emit.js) is mocked so this proves the WIRING — that
 * `liveListMeetings` calls it at most once per page for the process lifetime — not
 * `emitSignal`'s own behaviour, which tests/signal-emit.test.ts already owns.
 *
 * `meeting-followup.js` is imported DYNAMICALLY inside the test (matching
 * tests/schedule-signal-wiring.test.ts's own pattern), not statically at the top of the file:
 * a static import runs before this file's own top-level `const mockEmitSignal = vi.fn(...)`
 * has executed (imports are hoisted above ordinary statements), which would trip the mock
 * factory's `emitSignal: mockEmitSignal` reference into a temporal-dead-zone error the moment
 * the mocked module's import chain loads `../lib/signal-emit.js`.
 */

const mockEmitSignal = vi.fn(async () => {});
vi.mock("../lib/signal-emit.js", () => ({ emitSignal: mockEmitSignal }));

// Fixed clock for this test, 1 hour after BROKEN_PAGE's own `Date` property — well inside
// FOLLOWUP_MAX_AGE_DAYS, so the recency bound (services/chief-of-staff/agent/schedules/
// meeting-followup.ts) never interferes with this file's own concern (the mismatch dedupe).
const NOW = new Date("2026-08-20T10:00:00.000Z");

// A page whose `Summary` PROPERTY is filled (so it passes the cheap pre-filter and gets a
// markdown read) but whose page body never contains the `<meeting-notes><summary>` block the
// composer actually reads — the property-filled/block-empty contradiction (ORB-156 fix
// round 2) this test's page is built to trigger on every single tick.
const BROKEN_PAGE = {
  id: "page-mismatch-1",
  created_time: "2026-08-20T09:00:00.000Z",
  properties: {
    "Date": { date: { start: "2026-08-20T09:00:00.000Z" } },
    "Meeting Title": { title: [{ plain_text: "Broken Page" }] },
    "Series": { rich_text: [] },
    "Attendees": { rich_text: [{ plain_text: "Stefan <sam@example.com>" }] },
    "Action Items": { rich_text: [] },
    "Summary": { rich_text: [{ plain_text: "A dense one-paragraph property summary." }] },
  },
};

function fakeNotionFetch() {
  return vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/query")) {
      return new Response(
        JSON.stringify({ results: [BROKEN_PAGE], has_more: false, next_cursor: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "GET" && url.includes("/markdown")) {
      // No <meeting-notes> block anywhere — extractSummaryBlock will return "".
      return new Response(
        JSON.stringify({ markdown: "# Broken Page\n\nSome notes, no meeting-notes tag here." }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  });
}

// Nothing this test does ever claims/records the page, so the "done" set (sent/queued/skipped)
// stays empty across both calls — the row would be re-read from Notion every tick forever,
// which is exactly the scenario the dedupe has to hold up against.
const fakePool = { query: async () => ({ rows: [] }) } as unknown as Pool;

describe("liveListMeetings — summary-mismatch signal dedupe (finding 5)", () => {
  beforeEach(() => {
    process.env["NOTION_TOKEN"] = "test-token";
    delete process.env["EGRESS_PROXY_URL"];
    mockEmitSignal.mockClear();
    vi.stubGlobal("fetch", fakeNotionFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["NOTION_TOKEN"];
  });

  it("signals once across two consecutive ticks for the same mismatching page, not once per tick", async () => {
    const { liveListMeetings } = await import("../agent/schedules/meeting-followup.js");

    const first = await liveListMeetings(fakePool, NOW);
    expect(first).toEqual([]); // the contradiction excludes the row — it never becomes ready

    const second = await liveListMeetings(fakePool, NOW);
    expect(second).toEqual([]);

    const mismatchCalls = mockEmitSignal.mock.calls.filter(([kind]) => kind === "meeting-followup-summary-mismatch");
    expect(mismatchCalls).toHaveLength(1);
    expect(mismatchCalls[0]?.[1]).toContain("page-mismatch-1");
  });
});
