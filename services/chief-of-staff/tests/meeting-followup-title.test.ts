import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";
import type { FollowupDeps } from "../agent/schedules/meeting-followup.js";

/**
 * The trailing-ISO-string defect a human hit in production: an approval card asked Bendik to
 * authorise a meeting follow-up, and the meeting's title — the ONE line he reads to check the
 * agent matched the right meeting before it sends mail on his behalf — read
 * "Lyll.io 2025-10-03T09:00:00.000+02:00". Notion's `Meeting Title` property is an array of
 * rich-text items, and an inline `@date` mention's `plain_text` is the raw ISO string; naively
 * flattening every item (what `plainText` elsewhere in this file does) produces exactly that.
 *
 * The fix (`humanTitle`/`isDateMention` in meeting-followup.ts) strips date-mention items
 * STRUCTURALLY — by the item's own `type`/`mention.type` — mirroring services/notion-sync/
 * lib/adapters/notion-client.ts's `titleWithoutDateMentions`/`isDateMention`. Unlike
 * notion-sync, which keeps a raw `title` (transcript filename/H1) alongside a cleaned
 * `matchTitle` (the event matcher's key), nothing in THIS schedule matches or stores on the
 * title — `pageId` is the identity key throughout — so there is only one `title` field, and it
 * is cleaned once, at the point it is read from the Notion payload (`toCandidate`), rather than
 * living beside a preserved raw form.
 *
 * `meeting-followup.js` is re-imported FRESH (`vi.resetModules()` + dynamic `import()`) in every
 * test, not once statically: the module memoizes its Notion `fetch` in a module-scope
 * `notionFetchPromise` on first call (never re-read after), so a stale, previous-test fixture
 * would otherwise leak into every test after the first one in this file.
 */

function meetingNotesMarkdown(label: string): string {
  return `<meeting-notes>\n<summary>\nRecap: ${label}\n</summary>\n</meeting-notes>`;
}

const NOW = new Date("2026-08-24T12:00:00.000Z");

function readyPage(id: string, titleItems: unknown[]) {
  return {
    id,
    created_time: "2026-08-24T09:00:00.000Z",
    properties: {
      "Date": { date: { start: "2026-08-24T09:00:00.000Z" } },
      "Meeting Title": { title: titleItems },
      "Series": { rich_text: [] },
      "Attendees": { rich_text: [{ plain_text: "Stefan <sam@example.com>" }] },
      "Action Items": { rich_text: [] },
      "Summary": { rich_text: [{ plain_text: "A dense property summary." }] },
    },
  };
}

function fakeNotionFetch(page: ReturnType<typeof readyPage>) {
  return vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/query")) {
      return new Response(
        JSON.stringify({ results: [page], has_more: false, next_cursor: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "GET" && url.includes("/markdown")) {
      return new Response(
        JSON.stringify({ markdown: meetingNotesMarkdown(page.id) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  });
}

// No send-log rows — every fixture page here is otherwise fully eligible.
const fakePool = { query: async () => ({ rows: [] }) } as unknown as Pool;

beforeEach(() => {
  vi.resetModules();
  process.env["NOTION_TOKEN"] = "test-token";
  delete process.env["EGRESS_PROXY_URL"];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["NOTION_TOKEN"];
});

describe("liveListMeetings — Meeting Title date-mention stripping (title legibility fix)", () => {
  it("drops a trailing date mention and keeps the human words", async () => {
    const page = readyPage("page-lyll", [
      { type: "text", plain_text: "Lyll.io " },
      {
        type: "mention",
        mention: { type: "date", date: { start: "2025-10-03T09:00:00.000+02:00" } },
        plain_text: "2025-10-03T09:00:00.000+02:00",
      },
    ]);
    vi.stubGlobal("fetch", fakeNotionFetch(page));

    const { liveListMeetings } = await import("../agent/schedules/meeting-followup.js");
    const [row] = await liveListMeetings(fakePool, NOW);
    expect(row?.title).toBe("Lyll.io");
  });

  it("keeps a non-date mention — a person or page mention is part of the meeting's name", async () => {
    const page = readyPage("page-person", [
      { type: "text", plain_text: "Sync with " },
      { type: "mention", mention: { type: "user" }, plain_text: "Alex" },
    ]);
    vi.stubGlobal("fetch", fakeNotionFetch(page));

    const { liveListMeetings } = await import("../agent/schedules/meeting-followup.js");
    const [row] = await liveListMeetings(fakePool, NOW);
    expect(row?.title).toBe("Sync with Alex");
  });

  it("is unchanged for a title with no mention at all", async () => {
    const page = readyPage("page-plain", [{ type: "text", plain_text: "Folkepuls" }]);
    vi.stubGlobal("fetch", fakeNotionFetch(page));

    const { liveListMeetings } = await import("../agent/schedules/meeting-followup.js");
    const [row] = await liveListMeetings(fakePool, NOW);
    expect(row?.title).toBe("Folkepuls");
  });
});

describe("meeting-followup — the cleaned title is what reaches the tool payload's meetingTitle", () => {
  it("carries the date-mention-stripped title all the way to deps.send()'s payload — not just the listed row", async () => {
    const page = readyPage("page-lyll-2", [
      { type: "text", plain_text: "Lyll.io " },
      {
        type: "mention",
        mention: { type: "date", date: { start: "2025-10-03T09:00:00.000+02:00" } },
        plain_text: "2025-10-03T09:00:00.000+02:00",
      },
    ]);
    vi.stubGlobal("fetch", fakeNotionFetch(page));

    const { liveListMeetings, makeFollowupTick } = await import("../agent/schedules/meeting-followup.js");

    // Real conversion, same as the live schedule: raw Notion payload -> cleaned MeetingRow.
    const rows = await liveListMeetings(fakePool, NOW);

    const sent: unknown[] = [];
    const deps: FollowupDeps = {
      listMeetings: async () => rows,
      claim: async () => ({ claimed: true, attempt: 1, isFinalAttempt: false }),
      compose: async () => ({ subject: "Oppsummering", bodyText: "..." }),
      send: async (payload) => { sent.push(payload); },
      getOutcome: async () => "sent",
      recordOutcome: async () => {},
      reportAutonomousSendFailed: async () => {},
      reportDropped: async () => {},
      notify: async () => {},
      selfEmails: ["owner@owner.example"],
    };

    await makeFollowupTick(deps).tick(NOW);

    expect(sent).toHaveLength(1);
    // The approval card renders `meetingTitle` verbatim (packages/agent-kit/src/
    // approval-summary.ts) — a raw ISO string here is exactly the defect this test guards.
    expect((sent[0] as { meetingTitle: string }).meetingTitle).toBe("Lyll.io");
  });
});
