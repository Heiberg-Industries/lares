// A fake Notion over the exact HTTP surface lib/adapters/notion-client.ts speaks,
// shared by every test that drives a real composition function (cli.test.ts's T7
// block, resolve-seam.test.ts). One fake, not several: the composition roots build
// their own client from env, so the only seam a test has is `fetch` — and two
// hand-rolled fakes of the same API would be free to disagree about the one thing
// these tests are proving.
import { vi } from "vitest";

export interface FakeQueryRow {
  pageId: string;
  vaultPath: string;
  lastEditedTime: string;
  /**
   * The three MEETINGS properties (Phase 4, T4), all optional so a Docs-query row
   * stays byte-identical to what this helper emitted before they existed. The
   * transcript pass reads the same data-source query endpoint through
   * `toMeetingRow`, so one fake still answers for both databases.
   */
  title?: string;
  project?: string;
  startsAt?: string;
  /**
   * The two DOCS properties a Notion-BORN page is placed by (Phase 4, T6) — `Name`
   * (the page title) and `Folder`. Optional for the same reason the three above are:
   * a row that omits them is byte-identical to what this helper emitted before they
   * existed. `Project` is shared with the meetings shape above, since it is the same
   * property name in both databases.
   */
  name?: string;
  folder?: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

export interface FakeNotionState {
  /** pageId → what GET /markdown returns. Mutated by PATCH/POST, as Notion is. */
  markdown: Record<string, string>;
  /**
   * Successive data-source query responses; the LAST one repeats for every
   * further query. That is what makes the §18.5 ordering assertion possible —
   * the second snapshot models the `last_edited_time` bump the stamping causes.
   */
  queries: FakeQueryRow[][];
}

export function makeNotionFetch(state: FakeNotionState): {
  impl: ReturnType<typeof vi.fn>;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let queryCount = 0;
  let createdCount = 0;
  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    const body = init?.body === undefined
      ? undefined
      : JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ method, path, body });

    if (method === "POST" && path.endsWith("/query")) {
      const rows = state.queries[Math.min(queryCount, state.queries.length - 1)] ?? [];
      queryCount += 1;
      return json({
        results: rows.map((row) => ({
          id: row.pageId,
          last_edited_time: row.lastEditedTime,
          properties: {
            "Vault Path": { rich_text: [{ plain_text: row.vaultPath }] },
            ...(row.title === undefined
              ? {}
              : { "Meeting Title": { title: [{ plain_text: row.title }] } }),
            ...(row.project === undefined ? {} : { Project: { select: { name: row.project } } }),
            ...(row.startsAt === undefined ? {} : { Date: { date: { start: row.startsAt } } }),
            ...(row.name === undefined ? {} : { Name: { title: [{ plain_text: row.name }] } }),
            ...(row.folder === undefined ? {} : { Folder: { rich_text: [{ plain_text: row.folder }] } }),
          },
        })),
        has_more: false,
        next_cursor: null,
      });
    }
    if (method === "GET" && path.endsWith("/markdown")) {
      const pageId = path.split("/")[3];
      return json({ markdown: state.markdown[pageId] ?? "", truncated: false });
    }
    if (method === "PATCH" && path.endsWith("/markdown")) {
      const pageId = path.split("/")[3];
      const replace = (body?.replace_content ?? {}) as { new_str?: string };
      // Notion normalises what it stores — never byte-identical to what was sent.
      state.markdown[pageId] = `stored:${replace.new_str ?? ""}`;
      return json({});
    }
    if (method === "PATCH") return json({});
    if (method === "POST" && path === "/v1/pages") {
      createdCount += 1;
      const pageId = `pcreated${createdCount}`;
      state.markdown[pageId] = `stored:${String(body?.markdown ?? "")}`;
      return json({ id: pageId });
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { impl, requests };
}
