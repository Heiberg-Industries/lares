/**
 * A fake Notion for clipping tests: it speaks just enough of the REST API (data source retrieve,
 * data source query with a last-edited filter / ascending sort / paging, page retrieve) behind a
 * `fetch`, so the REAL official SDK client runs against it. That keeps the request shapes, the
 * pinned API version, the error classes, the retry and the timeout the production ones.
 *
 * FIXTURE, NOT PROOF: this is what we believe the API does. The live probe
 * (tests/live/notion-clipping.live.mts) is what it does.
 */
import { makeNotionClient, NOTION_API_VERSION } from "../../lib/clipping/notion-reader.js";
import type { InboxPort } from "../../lib/clipping/sync.js";

export interface FakePage {
  id: string;
  created_time: string;
  last_edited_time: string;
  in_trash: boolean;
  properties: Record<string, unknown>;
}

export const SCHEMA_PROPERTIES = {
  Name: { id: "title", name: "Name", type: "title" },
  Link: { id: "u1", name: "Link", type: "url" },
  Note: { id: "n1", name: "Note", type: "rich_text" },
  Tags: { id: "t1", name: "Tags", type: "multi_select" },
};

export function pageId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function mkPage(n: number, o: { url?: string | null; title?: string; edited?: string; trash?: boolean; note?: string } = {}): FakePage {
  const edited = o.edited ?? `2026-10-01T10:${String(n % 60).padStart(2, "0")}:00.000Z`;
  return {
    id: pageId(n),
    created_time: "2026-10-01T09:00:00.000Z",
    last_edited_time: edited,
    in_trash: o.trash ?? false,
    properties: {
      Name: { id: "title", type: "title", title: [{ plain_text: o.title ?? `Item ${n}` }] },
      Link: { id: "u1", type: "url", url: o.url === undefined ? `https://example.com/p/${n}` : o.url },
      Note: { id: "n1", type: "rich_text", rich_text: o.note ? [{ plain_text: o.note }] : [] },
      Tags: { id: "t1", type: "multi_select", multi_select: [] },
    },
  };
}

export interface Fault {
  /** Matches "METHOD /path". */
  match: RegExp;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Never answer (the SDK timeout must fire). */
  hang?: boolean;
  /** Throw a network error. */
  networkError?: boolean;
  /** How many times to apply; default forever. */
  times?: number;
}

export function fakeNotion() {
  const world = {
    properties: { ...SCHEMA_PROPERTIES } as Record<string, unknown>,
    pages: new Map<string, FakePage>(),
    faults: [] as Fault[],
    requests: [] as { key: string; version: string | null; body: Record<string, unknown> | null }[],
    /** When true the query returns trashed pages too (the docs are unclear whether it does). */
    queryIncludesTrashed: false,
    incompleteQuery: false,
  };

  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const key = `${method} ${u.pathname}`;
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    world.requests.push({ key, version: headers["notion-version"] ?? null, body });

    for (const f of world.faults) {
      if (!f.match.test(key)) continue;
      if (f.times !== undefined) { if (f.times <= 0) continue; f.times--; }
      if (f.hang) return new Promise<never>(() => undefined);
      if (f.networkError) throw new TypeError("fetch failed");
      return json(f.status ?? 500, f.body ?? { object: "error", status: f.status ?? 500, code: "internal_server_error", message: "boom" }, f.headers);
    }

    let m: RegExpMatchArray | null;
    if ((m = u.pathname.match(/^\/v1\/data_sources\/([^/]+)$/)) && method === "GET") {
      return json(200, { object: "data_source", id: m[1], properties: world.properties });
    }
    if ((m = u.pathname.match(/^\/v1\/data_sources\/([^/]+)\/query$/)) && method === "POST") {
      const filter = body?.["filter"] as { last_edited_time?: { on_or_after?: string } } | undefined;
      const since = filter?.last_edited_time?.on_or_after;
      let rows = [...world.pages.values()].filter((p) => world.queryIncludesTrashed || !p.in_trash);
      if (since) rows = rows.filter((p) => p.last_edited_time >= since);
      rows.sort((a, b) => a.last_edited_time.localeCompare(b.last_edited_time) || a.id.localeCompare(b.id));
      const size = Number(body?.["page_size"] ?? 100);
      const start = Number(body?.["start_cursor"] ?? 0);
      const slice = rows.slice(start, start + size);
      const more = start + size < rows.length;
      return json(200, {
        object: "list", type: "page_or_data_source", page_or_data_source: {},
        results: slice.map((p) => ({ object: "page", ...p })),
        has_more: more, next_cursor: more ? String(start + size) : null,
        request_status: { type: world.incompleteQuery ? "incomplete" : "complete" },
      });
    }
    if ((m = u.pathname.match(/^\/v1\/pages\/([^/]+)$/)) && method === "GET") {
      const p = world.pages.get(m[1]!);
      if (!p) return json(404, { object: "error", status: 404, code: "object_not_found", message: "Could not find page" });
      return json(200, { object: "page", ...p });
    }
    return json(404, { object: "error", status: 404, code: "invalid_request_url", message: "unknown route" });
  };

  return {
    world,
    fetch,
    /** The real SDK client, production settings except for fast retry timing. */
    client: (o: { timeoutMs?: number; maxRetries?: number } = {}) =>
      makeNotionClient({
        token: "test-token", fetch: fetch as never, timeoutMs: o.timeoutMs ?? 2_000,
        retry: { maxRetries: o.maxRetries ?? 2, maxRetryDelayMs: 20, initialRetryDelayMs: 5 },
      }),
    setPages(pages: FakePage[]) { world.pages = new Map(pages.map((p) => [p.id, p])); },
    put(p: FakePage) { world.pages.set(p.id, p); },
    version: NOTION_API_VERSION,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** An in-memory `_inbox`. `filed(path)` plays the digest: the note leaves the inbox. */
export function memInbox(): InboxPort & { files: Map<string, string>; writes: string[]; filed(path: string): void } {
  const files = new Map<string, string>();
  const writes: string[] = [];
  return {
    files, writes,
    exists: (p) => files.has(p),
    async write(p, b) { writes.push(p); files.set(p, b); },
    async remove(p) { files.delete(p); },
    filed(p) { files.delete(p); },
  };
}
