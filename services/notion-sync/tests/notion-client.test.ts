import { describe, it, expect, vi } from "vitest";
import { makeNotionClient, toMeetingRow, toDocRow, toPersonRow } from "../lib/adapters/notion-client.js";

const page = {
  id: "373cc987-b457-8005-9ffc-fcc1466543a5",
  last_edited_time: "2026-06-02T11:21:06.196Z",
  properties: {
    "Meeting Title": { title: [{ plain_text: "Alex // Bendik" }] },
    Project: { select: { name: "Zero7" } },
    Date: { date: { start: "2026-06-02T10:30:00.000Z" } },
    Attendees: { rich_text: [{ plain_text: "Alex <stein@example.com>" }] },
  },
};

const docPage = {
  id: "9a2cc987-b457-81d6-b42b-ebf220da5f11",
  last_edited_time: "2026-08-04T09:00:00.000Z",
  properties: {
    Name: { title: [{ plain_text: "Ada" }] },
    "Vault Path": { rich_text: [{ plain_text: "wiki/people/ada.md" }] },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("toMeetingRow", () => {
  it("extracts title, project, date and attendees", () => {
    const row = toMeetingRow(page);
    expect(row.pageId).toBe("373cc987-b457-8005-9ffc-fcc1466543a5");
    expect(row.title).toBe("Alex // Bendik");
    expect(row.project).toBe("Zero7");
    expect(row.startsAt).toBe("2026-06-02T10:30:00.000Z");
    expect(row.startsAtSource).toBe("date-property");
    expect(row.dateHasTime).toBe(true);
    expect(row.attendees).toBe("Alex <stein@example.com>");
  });

  it("returns nulls and empty strings for missing properties", () => {
    const row = toMeetingRow({ id: "p", last_edited_time: "t", properties: {} });
    expect(row.project).toBeNull();
    expect(row.startsAt).toBeNull();
    expect(row.startsAtSource).toBe("none");
    expect(row.title).toBe("");
    expect(row.attendees).toBe("");
  });

  it("reads the Series property back", () => {
    const withSeries = toMeetingRow({
      ...page,
      properties: { ...page.properties, Series: { rich_text: [{ plain_text: "abc123" }] } },
    });
    expect(withSeries.series).toBe("abc123");
    expect(toMeetingRow(page).series).toBe("");
  });
});

// ORB-155. Notion's meeting-notes feature stopped filling the `Date` property with a
// time around 2026-08-10; the meeting's real start now arrives as a structured date
// MENTION inside the title, and a hand-typed `Date` is date-only, which parses to
// midnight and so can never fall inside the +/-15-minute match window. These are the
// three sources, in the order the matcher must prefer them.
describe("toMeetingRow — where the start time comes from (ORB-155)", () => {
  /** Today's live Folkepuls page, as the REST API actually returns it. */
  const mentionPage = {
    id: "3c6cc987-b457-8108-93cc-fee5786e7b42",
    created_time: "2026-08-24T07:58:00.000Z",
    last_edited_time: "2026-08-24T08:40:00.000Z",
    properties: {
      "Meeting Title": {
        title: [
          { type: "text", plain_text: "Folkepuls " },
          {
            type: "mention",
            mention: { type: "date", date: { start: "2026-08-24T10:00:00.000+02:00", end: null, time_zone: null } },
            plain_text: "2026-08-24T10:00:00.000+02:00",
          },
        ],
      },
      Project: { select: { name: "Other" } },
      Date: { date: { start: "2026-08-24", end: null, time_zone: null } },
      Attendees: { rich_text: [] },
    },
  };

  it("prefers the `Date` property when it carries a time", () => {
    const row = toMeetingRow({
      ...mentionPage,
      properties: { ...mentionPage.properties, Date: { date: { start: "2026-08-24T09:00:00.000+02:00" } } },
    });
    expect(row.startsAt).toBe("2026-08-24T09:00:00.000+02:00");
    expect(row.startsAtSource).toBe("date-property");
    expect(row.dateHasTime).toBe(true);
  });

  it("falls through a date-only `Date` to the title's date mention", () => {
    const row = toMeetingRow(mentionPage);
    expect(row.startsAt).toBe("2026-08-24T10:00:00.000+02:00");
    expect(row.startsAtSource).toBe("title-mention");
    // The half that authorises the write-back: a date-only value may be upgraded.
    expect(row.dateHasTime).toBe(false);
  });

  it("ignores a date mention that is itself date-only, and falls back to created_time", () => {
    const row = toMeetingRow({
      ...mentionPage,
      properties: {
        ...mentionPage.properties,
        "Meeting Title": {
          title: [
            { type: "text", plain_text: "Folkepuls " },
            { type: "mention", mention: { type: "date", date: { start: "2026-08-24" } }, plain_text: "2026-08-24" },
          ],
        },
      },
    });
    expect(row.startsAt).toBe("2026-08-24T07:58:00.000Z");
    expect(row.startsAtSource).toBe("created-time");
  });

  it("falls back to created_time when neither property nor title carries a time", () => {
    const row = toMeetingRow({
      id: "3c0cc987-b457-8056-95f4-dc2cf716ecdb",
      created_time: "2026-08-18T11:12:00.000Z",
      last_edited_time: "2026-08-18T12:00:00.000Z",
      properties: {
        "Meeting Title": { title: [{ type: "text", plain_text: "Folkepuls m/Stefan & Kjetil" }] },
        Date: { date: { start: "2026-08-18" } },
      },
    });
    expect(row.startsAt).toBe("2026-08-18T11:12:00.000Z");
    expect(row.startsAtSource).toBe("created-time");
    expect(row.dateHasTime).toBe(false);
  });

  it("reports `none` when there is no property, no mention and no created_time", () => {
    const row = toMeetingRow({ id: "p", last_edited_time: "t", properties: {} });
    expect(row.startsAt).toBeNull();
    expect(row.startsAtSource).toBe("none");
  });

  it("carries created_time through for the starvation window", () => {
    expect(toMeetingRow(mentionPage).createdAt).toBe("2026-08-24T07:58:00.000Z");
  });
});

// The mention's `plain_text` is the RAW ISO string, so the title Notion reports for
// today's Folkepuls page is "Folkepuls 2026-08-24T10:00:00.000+02:00". Fed to the
// title tie-break, that is seven words of date noise against one real word, and the
// event "Folkepuls" scores 1/7 — under the 0.5 gate, so the gate could never pass.
// `title` itself is left alone: it is the transcript's H1 and its filename stem, and
// every transcript already on disk was named from it.
describe("toMeetingRow — matchTitle strips the date mention (ORB-155)", () => {
  it("drops date mentions and keeps the human words", () => {
    const row = toMeetingRow({
      id: "p",
      created_time: "2026-08-24T07:58:00.000Z",
      last_edited_time: "t",
      properties: {
        "Meeting Title": {
          title: [
            { type: "text", plain_text: "Folkepuls " },
            { type: "mention", mention: { type: "date", date: { start: "2026-08-24T10:00:00.000+02:00" } }, plain_text: "2026-08-24T10:00:00.000+02:00" },
          ],
        },
      },
    });
    expect(row.matchTitle).toBe("Folkepuls");
    // Unchanged, so no transcript is renamed and no H1 rewritten by this fix.
    expect(row.title).toBe("Folkepuls 2026-08-24T10:00:00.000+02:00");
  });

  it("keeps a non-date mention — a person or page mention is part of the name", () => {
    const row = toMeetingRow({
      id: "p",
      last_edited_time: "t",
      properties: {
        "Meeting Title": {
          title: [
            { type: "text", plain_text: "Sync with " },
            { type: "mention", mention: { type: "user" }, plain_text: "Alex" },
          ],
        },
      },
    });
    expect(row.matchTitle).toBe("Sync with Alex");
  });

  it("equals the title when there is no mention at all", () => {
    expect(toMeetingRow(page).matchTitle).toBe("Alex // Bendik");
  });
});

describe("makeNotionClient", () => {
  it("sends the pinned version header and follows pagination", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (seen.length === 1) {
        return jsonResponse({ results: [page], has_more: true, next_cursor: "cur-2" });
      }
      return jsonResponse({ results: [{ ...page, id: "second" }], has_more: false, next_cursor: null });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "secret", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    const rows = await client.queryMeetings("ds-1");

    expect(rows.map((r) => r.pageId)).toEqual([
      "373cc987-b457-8005-9ffc-fcc1466543a5", "second",
    ]);
    expect(seen[0].url).toBe("https://api.notion.com/v1/data_sources/ds-1/query");
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers["Notion-Version"]).toBe("2026-03-11");
    expect(headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(String(seen[1].init.body))).toMatchObject({ start_cursor: "cur-2" });
  });

  it("retries once after a 429 and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      }
      return jsonResponse({ results: [], has_more: false, next_cursor: null });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.queryMeetings("ds-1")).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  it("waits for the exact Retry-After duration before retrying a 429", async () => {
    // The test above proves *a* retry happens with Retry-After: 0. It would pass
    // identically for a hardcoded backoff. This proves the header value itself is
    // read and honoured, per the "429 retry honouring Retry-After" constraint.
    vi.useFakeTimers();
    try {
      let calls = 0;
      const timestamps: number[] = [];
      const fetchImpl = (async () => {
        calls += 1;
        timestamps.push(Date.now());
        if (calls === 1) {
          return new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } });
        }
        return jsonResponse({ results: [], has_more: false, next_cursor: null });
      }) as unknown as typeof globalThis.fetch;

      const client = makeNotionClient({
        token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
      });

      const pending = client.queryMeetings("ds-1");
      await vi.advanceTimersByTimeAsync(1_999);
      expect(calls).toBe(1); // still inside the 2s Retry-After window

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual([]);
      expect(calls).toBe(2);
      expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles consecutive requests to at least minIntervalMs apart", async () => {
    // Every other test sets minIntervalMs: 0, which never exercises the throttle
    // gap itself. This proves the second request is held back until the interval
    // elapses, not just that requests eventually complete.
    vi.useFakeTimers();
    try {
      const timestamps: number[] = [];
      const fetchImpl = (async () => {
        timestamps.push(Date.now());
        return jsonResponse({ results: [], has_more: false, next_cursor: null });
      }) as unknown as typeof globalThis.fetch;

      const client = makeNotionClient({
        token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 350,
      });

      await client.queryMeetings("ds-1");

      const second = client.queryMeetings("ds-1");
      await vi.advanceTimersByTimeAsync(349);
      expect(timestamps).toHaveLength(1); // throttle is still holding the second call

      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(timestamps).toHaveLength(2);
      expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(350);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes Attendees as a rich_text property", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await client.updateMeetingMatch("page-1", { attendees: "Ada <ada@example.com>" });

    expect(seen[0].url).toBe("https://api.notion.com/v1/pages/page-1");
    expect(seen[0].init.method).toBe("PATCH");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      properties: {
        Attendees: { rich_text: [{ type: "text", text: { content: "Ada <ada@example.com>" } }] },
      },
    });
  });

  it("sends Attendees and the upgraded Date in ONE patch (ORB-155)", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await client.updateMeetingMatch("page-1", {
      attendees: "Ada <ada@example.com>",
      startsAt: "2026-08-24T10:00:00.000+02:00",
    });

    expect(seen).toHaveLength(1);
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      properties: {
        Attendees: { rich_text: [{ type: "text", text: { content: "Ada <ada@example.com>" } }] },
        Date: { date: { start: "2026-08-24T10:00:00.000+02:00" } },
      },
    });
  });

  it("writes Series in the SAME patch as Attendees and Date (ORB-156)", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await client.updateMeetingMatch("page-1", {
      attendees: "Ada <ada@example.com>",
      startsAt: "2026-08-24T10:00:00.000+02:00",
      seriesKey: "fixture-recurring-event",
    });

    expect(seen).toHaveLength(1);
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      properties: {
        Attendees: { rich_text: [{ type: "text", text: { content: "Ada <ada@example.com>" } }] },
        Date: { date: { start: "2026-08-24T10:00:00.000+02:00" } },
        Series: { rich_text: [{ type: "text", text: { content: "fixture-recurring-event" } }] },
      },
    });
  });

  it("omits Series when the meeting is not part of a series", async () => {
    const seen: Array<{ init: RequestInit }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push({ init });
      return jsonResponse({ id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await client.updateMeetingMatch("page-1", { attendees: "Ada <ada@example.com>" });

    const body = JSON.parse(String(seen[0].init.body));
    expect("Series" in body.properties).toBe(false);
  });

  it("throws with status and body when Notion returns an error", async () => {
    const fetchImpl = (async () =>
      new Response("bad request", { status: 400 })) as unknown as typeof globalThis.fetch;
    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.queryMeetings("ds-1")).rejects.toThrow(/400 bad request/);
  });
});

describe("toDocRow", () => {
  it("extracts pageId, vaultPath and lastEditedTime", () => {
    const row = toDocRow(docPage);
    expect(row.pageId).toBe("9a2cc987-b457-81d6-b42b-ebf220da5f11");
    expect(row.vaultPath).toBe("wiki/people/ada.md");
    expect(row.lastEditedTime).toBe("2026-08-04T09:00:00.000Z");
  });

  it("returns empty strings for missing properties", () => {
    const row = toDocRow({ id: "p", last_edited_time: "t", properties: {} });
    expect(row.vaultPath).toBe("");
  });

  it("joins a chunked Vault Path back into one string", () => {
    // Rich-text values we write are chunked at 2000 chars (see createDocPage);
    // reading one back must not silently drop everything after the first chunk.
    const row = toDocRow({
      id: "p",
      last_edited_time: "t",
      properties: {
        "Vault Path": { rich_text: [{ plain_text: "wiki/a-very-" }, { plain_text: "long-name.md" }] },
      },
    });
    expect(row.vaultPath).toBe("wiki/a-very-long-name.md");
  });
});

describe("queryDocs", () => {
  it("queries the data source and follows pagination", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (seen.length === 1) {
        return jsonResponse({ results: [docPage], has_more: true, next_cursor: "cur-2" });
      }
      return jsonResponse({ results: [{ ...docPage, id: "second" }], has_more: false, next_cursor: null });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    const rows = await client.queryDocs("ds-docs");

    expect(rows.map((r) => r.pageId)).toEqual([
      "9a2cc987-b457-81d6-b42b-ebf220da5f11", "second",
    ]);
    expect(seen[0].url).toBe("https://api.notion.com/v1/data_sources/ds-docs/query");
    expect(JSON.parse(String(seen[1].init.body))).toMatchObject({ start_cursor: "cur-2" });
  });
});

describe("getPageMarkdown", () => {
  it("GETs the markdown endpoint and returns the markdown string", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({
        object: "page_markdown", id: "page-1", markdown: "# Ada\n\nBody.",
        truncated: false, unknown_block_ids: [],
      });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.getPageMarkdown("page-1")).resolves.toBe("# Ada\n\nBody.");

    expect(seen[0].url).toBe("https://api.notion.com/v1/pages/page-1/markdown");
    expect(seen[0].init.method).toBe("GET");
    expect(seen[0].init.body).toBeUndefined();
  });

  it("throws when the response is truncated", async () => {
    // Hash-after-write is the sole defence against self-conflict (spec §3). Hashing
    // half a page as if it were whole would poison the stored hash silently, so a
    // truncated read must be loud instead.
    const fetchImpl = (async () => jsonResponse({
      object: "page_markdown", id: "page-1", markdown: "# Half",
      truncated: true, unknown_block_ids: ["b-1"],
    })) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.getPageMarkdown("page-1")).rejects.toThrow(/truncated/);
  });

  it("throws when the response carries no markdown string", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ object: "page_markdown", id: "page-1" })) as unknown as typeof globalThis.fetch;
    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.getPageMarkdown("page-1")).rejects.toThrow(/markdown/);
  });

  it("retries after a 429 like every other request", async () => {
    // Proves the new endpoints flow through the shared request() (throttle + retry),
    // not a parallel fetch path.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      }
      return jsonResponse({
        object: "page_markdown", id: "page-1", markdown: "ok",
        truncated: false, unknown_block_ids: [],
      });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.getPageMarkdown("page-1")).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("patchPageMarkdown", () => {
  it("PATCHes a wholesale replace_content body", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({
        object: "page_markdown", id: "page-1", markdown: "# New",
        truncated: false, unknown_block_ids: [],
      });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await client.patchPageMarkdown("page-1", "# New\n\nBody.");

    expect(seen[0].url).toBe("https://api.notion.com/v1/pages/page-1/markdown");
    expect(seen[0].init.method).toBe("PATCH");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      type: "replace_content",
      replace_content: { new_str: "# New\n\nBody.", allow_deleting_content: false },
    });
  });
});

describe("createDocPage", () => {
  const props = {
    name: "Ada",
    project: "Atlas",
    folder: "wiki/people",
    vaultPath: "wiki/people/ada.md",
    frontmatter: "---\ntitle: Ada\n---",
    archived: false,
  };

  it("POSTs a data_source parent, full properties and the markdown body", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ object: "page", id: "page-new" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    const created = await client.createDocPage("ds-docs", props, "# Ada\n\nBody.");

    expect(created).toEqual({ pageId: "page-new" });
    expect(seen[0].url).toBe("https://api.notion.com/v1/pages");
    expect(seen[0].init.method).toBe("POST");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      parent: { type: "data_source_id", data_source_id: "ds-docs" },
      properties: {
        Name: { title: [{ type: "text", text: { content: "Ada" } }] },
        Project: { select: { name: "Atlas" } },
        Folder: { rich_text: [{ type: "text", text: { content: "wiki/people" } }] },
        "Vault Path": { rich_text: [{ type: "text", text: { content: "wiki/people/ada.md" } }] },
        Frontmatter: { rich_text: [{ type: "text", text: { content: "---\ntitle: Ada\n---" } }] },
        Archived: { checkbox: false },
      },
      markdown: "# Ada\n\nBody.",
    });
  });

  it("chunks a long Frontmatter into 2000-char rich_text items", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ object: "page", id: "page-new" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    const long = "x".repeat(4100);
    await client.createDocPage("ds-docs", { ...props, frontmatter: long }, "# A");

    const body = JSON.parse(String(seen[0].init.body)) as {
      properties: { Frontmatter: { rich_text: Array<{ type: string; text: { content: string } }> } };
    };
    const chunks = body.properties.Frontmatter.rich_text;
    expect(chunks.map((c) => c.text.content.length)).toEqual([2000, 2000, 100]);
    expect(chunks.every((c) => c.type === "text")).toBe(true);
    expect(chunks.map((c) => c.text.content).join("")).toBe(long);
  });

  it("throws when the response carries no page id", async () => {
    // A created page we cannot identify can never be patched, hashed or archived —
    // and an empty-string id would collide in the store's UNIQUE column.
    const fetchImpl = (async () =>
      jsonResponse({ object: "page" })) as unknown as typeof globalThis.fetch;
    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.createDocPage("ds-docs", props, "# A")).rejects.toThrow(/page id/);
  });
});

describe("updateDocProps", () => {
  it("writes only the provided properties (Archived flag)", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ object: "page", id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await client.updateDocProps("page-1", { archived: true });

    expect(seen[0].url).toBe("https://api.notion.com/v1/pages/page-1");
    expect(seen[0].init.method).toBe("PATCH");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      properties: { Archived: { checkbox: true } },
    });
  });

  it("refreshes Frontmatter, emitting an empty rich_text for an empty value", async () => {
    // A file whose frontmatter was removed must clear the property, not keep the
    // stale value or send a zero-length text item.
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ object: "page", id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await client.updateDocProps("page-1", { frontmatter: "" });

    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      properties: { Frontmatter: { rich_text: [] } },
    });
  });

  it("writes Sync as a select property when provided", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ object: "page", id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await client.updateDocProps("page-1", { sync: "mirror" });

    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      properties: { Sync: { select: { name: "mirror" } } },
    });
  });
});

describe("updatePageMeta", () => {
  it("sets an emoji icon", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ object: "page", id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await client.updatePageMeta("page-1", { icon: "🔒" });

    expect(seen[0].url).toBe("https://api.notion.com/v1/pages/page-1");
    expect(seen[0].init.method).toBe("PATCH");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      icon: { type: "emoji", emoji: "🔒" },
    });
  });

  it("clears the icon when passed null", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ object: "page", id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await client.updatePageMeta("page-1", { icon: null });

    expect(JSON.parse(String(seen[0].init.body))).toEqual({ icon: null });
  });

  it("sets is_locked", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ object: "page", id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await client.updatePageMeta("page-1", { isLocked: true });

    expect(JSON.parse(String(seen[0].init.body))).toEqual({ is_locked: true });
  });

  it("sets icon and is_locked together in one PATCH", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ object: "page", id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await client.updatePageMeta("page-1", { icon: "🔒", isLocked: true });

    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      icon: { type: "emoji", emoji: "🔒" },
      is_locked: true,
    });
  });

  it("throws when no fields are provided, without making a request", async () => {
    // A no-op PATCH is a programming error (§ task brief) — catch it before any
    // network call, not as a Notion 400.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ object: "page", id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.updatePageMeta("page-1", {})).rejects.toThrow(/no fields/);
    expect(calls).toBe(0);
  });
});

// Notion's real error shape ({"object":"error","status":...,"code":...,"message":...}),
// for the three live-verified response bodies trashPage must tell apart (fix
// round 1, Critical finding). Building the JSON body this way — not a bare
// string like the old tests used — is what lets isAlreadyDone parse `code`
// out of it, exactly as the real API's body would let the adapter parse it.
function notionError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ object: "error", status, code, message }), { status });
}

describe("trashPage", () => {
  it("PATCHes { in_trash: true } and reports alreadyDone: false on success", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ object: "page", id: "page-1", in_trash: true });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.trashPage("page-1")).resolves.toEqual({ alreadyDone: false });

    expect(seen[0].url).toBe("https://api.notion.com/v1/pages/page-1");
    expect(seen[0].init.method).toBe("PATCH");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ in_trash: true });
  });

  it("classifies a 404 object_not_found (page already gone) as alreadyDone: true, not a throw", async () => {
    // Live-probed 2026-08-05 (fix round 1): a page already purged from Notion's
    // trash, or a stale id, 404s this PATCH — success from the caller's point of
    // view (there is nothing left to trash), never a failure. This is what lets
    // the archive command's re-runs stay idempotent instead of erroring on their
    // own past work.
    const fetchImpl = (async () => notionError(
      404, "object_not_found", "Could not find page with ID: gone-page.",
    )) as unknown as typeof globalThis.fetch;
    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.trashPage("gone-page")).resolves.toEqual({ alreadyDone: true });
  });

  it("classifies a 404 with no parseable body the same way — status alone is enough", async () => {
    // A proxy or an unusual failure mode might not carry Notion's JSON error
    // shape at all. This endpoint has no OTHER reason to 404, so status alone
    // is a safe signal — unlike the 400 case below, which needs the tight
    // code+message match because 400 is used for many unrelated failures.
    const fetchImpl = (async () =>
      new Response("Could not find page", { status: 404 })) as unknown as typeof globalThis.fetch;
    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.trashPage("gone-page")).resolves.toEqual({ alreadyDone: true });
  });

  it("classifies a repeat trash (400 validation_error, already archived) as alreadyDone: true — NOT a 200", async () => {
    // THE Critical fix (fix round 1): live-probed 2026-08-05 against the real
    // Docs data source at the pinned version (2026-03-11) — create a page,
    // PATCH {in_trash:true} once (200, in_trash:true), then PATCH it AGAIN:
    //   400 {"code":"validation_error","message":"Can't edit block that is
    //   archived. You must unarchive the block before editing."}
    // NOT a 200 and NOT a 404. The original implementation assumed an
    // idempotent 200 here, which is false and was the actual production bug:
    // an orphan-write failure after a successful trash left the row 'synced',
    // and a re-run's repeat trash call would have been misclassified as a hard
    // failure, permanently blocking the row from ever being healed.
    const fetchImpl = (async () => notionError(
      400, "validation_error",
      "Can't edit block that is archived. You must unarchive the block before editing.",
    )) as unknown as typeof globalThis.fetch;
    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.trashPage("already-trashed-page")).resolves.toEqual({ alreadyDone: true });
  });

  it("still throws a 400 validation_error that is NOT the already-archived case", async () => {
    // A validation_error is not exclusively this one condition — plenty of
    // other bad-request shapes carry the same code. Only the exact phrase
    // matches; anything else is a genuine failure and must not be swallowed.
    const fetchImpl = (async () => notionError(
      400, "validation_error", "body failed validation: title.length should be ≤ 2000.",
    )) as unknown as typeof globalThis.fetch;
    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.trashPage("page-1")).rejects.toThrow(/validation_error/);
  });

  it("still throws a 400 validation_error that names the Archived PROPERTY — must not be swallowed", async () => {
    // The exact false-positive the tight match exists to prevent: this
    // database has its own `Archived` checkbox PROPERTY (DocPageProps), and a
    // validation error about THAT property is also a validation_error whose
    // message contains the word "archived". Matching on the loose word alone
    // would misclassify a genuinely broken write as success-already-done.
    const fetchImpl = (async () => notionError(
      400, "validation_error", "Archived is expected to be boolean, instead was `\"yes\"`.",
    )) as unknown as typeof globalThis.fetch;
    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.trashPage("page-1")).rejects.toThrow(/validation_error/);
  });

  it("still throws for a non-404/non-400 failure", async () => {
    const fetchImpl = (async () =>
      new Response("server error", { status: 500 })) as unknown as typeof globalThis.fetch;
    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.trashPage("page-1")).rejects.toThrow(/500/);
  });

  it("retries after a 429 like every other request, then succeeds", async () => {
    // Proves trashPage flows through the shared request() (throttle + retry) and
    // does not re-implement its own fetch path.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      }
      return jsonResponse({ object: "page", id: "page-1" });
    }) as unknown as typeof globalThis.fetch;

    const client = makeNotionClient({
      token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0,
    });
    await expect(client.trashPage("page-1")).resolves.toEqual({ alreadyDone: false });
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The People database and the two Meetings properties beside it (Phase 4, T7)
// ---------------------------------------------------------------------------

const personPage = {
  id: "aa1cc987-b457-81d6-b42b-ebf220da5f11",
  last_edited_time: "2026-08-06T09:00:00.000Z",
  properties: {
    Name: { title: [{ plain_text: "Alex Partner" }] },
    Email: { email: "alex@partner.example" },
    Source: { select: { name: "Twenty" } },
    "Source ID": { rich_text: [{ plain_text: " rec-1 " }] },
  },
};

describe("toPersonRow", () => {
  it("reads the four projected properties", () => {
    expect(toPersonRow(personPage)).toEqual({
      pageId: "aa1cc987-b457-81d6-b42b-ebf220da5f11",
      name: "Alex Partner",
      // Lower-cased and trimmed AT THE BOUNDARY: every comparison downstream is
      // then on one form, so a row typed by hand cannot become a second person.
      email: "alex@partner.example",
      source: "Twenty",
      sourceId: "rec-1",
    });
  });

  it("reads a hand-made row — no Source, no Source ID, no Email — as blanks", () => {
    expect(toPersonRow({ id: "p", properties: { Name: { title: [{ plain_text: "Ada" }] } } }))
      .toEqual({ pageId: "p", name: "Ada", email: "", source: "", sourceId: "" });
  });
});

describe("toMeetingRow — the People relation and its flag", () => {
  it("reads the relation, and reports when Notion withheld part of it", () => {
    const row = toMeetingRow({
      ...page,
      properties: {
        ...page.properties,
        People: { relation: [{ id: "a" }, { id: "b" }], has_more: true },
        "People Unmatched": { rich_text: [{ plain_text: "ghost@nowhere.io" }] },
      },
    });
    expect(row.people).toEqual(["a", "b"]);
    expect(row.peopleTruncated).toBe(true);
    expect(row.peopleUnmatched).toBe("ghost@nowhere.io");
  });

  // The safety property that lets this ship BEFORE the properties exist on the
  // database: a missing property reads as "no links", and only a WRITE can fail.
  it("reads a database that has neither property as empty and untruncated", () => {
    const row = toMeetingRow(page);
    expect(row.people).toEqual([]);
    expect(row.peopleTruncated).toBe(false);
    expect(row.peopleUnmatched).toBe("");
  });
});

describe("makeNotionClient — People writes", () => {
  function capture(): { calls: Array<{ url: string; body: unknown }>; fetchImpl: typeof globalThis.fetch } {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return jsonResponse({ id: "created-1" });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetchImpl };
  }

  it("creates a People row with properties and NO body", async () => {
    const { calls, fetchImpl } = capture();
    const client = makeNotionClient({ token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0 });

    await expect(client.createPersonPage("ds-1", {
      name: "Alex Partner", email: "alex@partner.example", source: "Twenty", sourceId: "rec-1",
    })).resolves.toEqual({ pageId: "created-1" });

    expect(calls[0]?.url).toBe("https://api.notion.com/v1/pages");
    expect(calls[0]?.body).toEqual({
      parent: { type: "data_source_id", data_source_id: "ds-1" },
      properties: {
        Name: { title: [{ type: "text", text: { content: "Alex Partner" } }] },
        Email: { email: "alex@partner.example" },
        Source: { select: { name: "Twenty" } },
        "Source ID": { rich_text: [{ type: "text", text: { content: "rec-1" } }] },
      },
    });
    // A projection holds no content of its own — see createPersonPage.
    expect(calls[0]?.body).not.toHaveProperty("markdown");
  });

  it("refuses a create whose response carries no page id", async () => {
    const fetchImpl = (async () => jsonResponse({})) as unknown as typeof globalThis.fetch;
    const client = makeNotionClient({ token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0 });
    await expect(client.createPersonPage("ds-1", {
      name: "A", email: "a@x.io", source: "S", sourceId: "1",
    })).rejects.toThrow(/no page id/);
  });

  it("emits ONLY the properties it was asked to change", async () => {
    const { calls, fetchImpl } = capture();
    const client = makeNotionClient({ token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0 });

    await client.updatePersonProps("page-1", { name: "Alex V. Partner" });
    expect(calls[0]?.body).toEqual({
      properties: { Name: { title: [{ type: "text", text: { content: "Alex V. Partner" } }] } },
    });
  });

  it("writes the relation and its flag in ONE patch", async () => {
    const { calls, fetchImpl } = capture();
    const client = makeNotionClient({ token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0 });

    await client.updateMeetingPeople("meet-1", { people: ["a", "b"], unmatched: "ghost@nowhere.io" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.notion.com/v1/pages/meet-1");
    expect(calls[0]?.body).toEqual({
      properties: {
        People: { relation: [{ id: "a" }, { id: "b" }] },
        "People Unmatched": { rich_text: [{ type: "text", text: { content: "ghost@nowhere.io" } }] },
      },
    });
  });

  it("clears both halves with Notion's own empty representations", async () => {
    const { calls, fetchImpl } = capture();
    const client = makeNotionClient({ token: "t", version: "2026-03-11", fetchImpl, minIntervalMs: 0 });

    await client.updateMeetingPeople("meet-1", { people: [], unmatched: "" });
    expect(calls[0]?.body).toEqual({
      properties: { People: { relation: [] }, "People Unmatched": { rich_text: [] } },
    });
  });
});
