/**
 * ORB-289 / ORB-286 round 5 — Notion links go to the Notion API, not the readability worker.
 * Response shapes follow the endpoints `agent/schedules/meeting-followup.ts` already reads in
 * production (`GET /v1/pages/{id}`, `GET /v1/pages/{id}/markdown`); shaped, not recorded.
 * The live check is in tests/live/notion-page.live.mts.
 */
import { describe, it, expect } from "vitest";

import { NotionPageUnavailableError, notionPageIdFromUrl, readNotionPage } from "../lib/notion-page.js";

const ID = "27fcc987b4578092830c000b13ab5b0b";
const DASHED = "27fcc987-b457-8092-830c-000b13ab5b0b";

describe("notionPageIdFromUrl", () => {
  it("reads the id from the link shapes Notion hands out", () => {
    expect(notionPageIdFromUrl(`https://www.notion.so/heiberg/Folkepuls-sync-${ID}`)).toBe(DASHED);
    expect(notionPageIdFromUrl(`https://www.notion.so/${ID}`)).toBe(DASHED);
    expect(notionPageIdFromUrl(`https://notion.so/Folkepuls-${ID}?pvs=4`)).toBe(DASHED);
    expect(notionPageIdFromUrl(`https://heiberg.notion.site/Page-${ID}`)).toBe(DASHED);
    expect(notionPageIdFromUrl(`https://www.notion.so/heiberg/abc123?p=${ID}&pm=s`)).toBe(DASHED);
    expect(notionPageIdFromUrl(`https://www.notion.so/${DASHED}`)).toBe(DASHED);
  });

  it("is null for anything that is not a Notion page link", () => {
    expect(notionPageIdFromUrl("https://paulgraham.com/greatwork.html")).toBeNull();
    expect(notionPageIdFromUrl(`https://notnotion.so/${ID}`)).toBeNull();
    expect(notionPageIdFromUrl(`https://notion.so.evil.test/${ID}`)).toBeNull();
    expect(notionPageIdFromUrl("https://www.notion.so/heiberg/no-id-here")).toBeNull();
    expect(notionPageIdFromUrl("not a url")).toBeNull();
  });
});

function stub(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const r = routes[path] ?? { status: 404, body: { object: "error" } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("readNotionPage", () => {
  const url = `https://www.notion.so/heiberg/Folkepuls-${ID}`;

  it("returns the page title and its markdown", async () => {
    const out = await readNotionPage(url, {
      token: () => "secret_test",
      fetch: stub({
        [`/v1/pages/${DASHED}`]: { status: 200, body: { properties: { Name: { type: "title", title: [{ plain_text: "Folkepuls sync" }] } } } },
        [`/v1/pages/${DASHED}/markdown`]: { status: 200, body: { markdown: "# Folkepuls\n\nOwner: Kjetil" } },
      }),
    });
    expect(out).toEqual({ title: "Folkepuls sync", text: "# Folkepuls\n\nOwner: Kjetil" });
  });

  it("says plainly that a page is not shared with the integration (404)", async () => {
    await expect(readNotionPage(url, { token: () => "secret_test", fetch: stub({}) })).rejects.toThrow(NotionPageUnavailableError);
    await expect(readNotionPage(url, { token: () => "secret_test", fetch: stub({}) })).rejects.toThrow(/not shared with Saga's Notion integration/);
  });
});
