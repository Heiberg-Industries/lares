// A STATEFUL fake Notion: it stores what was written and answers the next query
// with it, over the exact HTTP surface lib/adapters/notion-client.ts speaks.
//
// Deliberately a second fake beside `fake-notion.ts`, not a widening of it, because
// the two answer opposite questions. That one replays a SCRIPTED sequence of query
// snapshots, which is what the §18.5 ordering assertions need (the second snapshot
// models the last_edited_time bump the stamping causes). A steady-state test needs
// the reverse: no script at all, and every read answered by what the previous tick
// wrote. Widening the scripted fake to also be a store would have given every
// existing test a second, silent behaviour.
//
// What it models, and why each detail is load-bearing for T7:
//
//   - **Write shape ≠ read shape.** Notion takes `{title:[{type:"text",text:{content}}]}`
//     and gives back `{title:[{plain_text}]}`; it takes `{relation:[{id}]}` and gives
//     back `{relation:[{id}], has_more}`. A projection that writes one shape and reads
//     another is the exact "correct for one tick, broken on the next" defect this
//     phase keeps producing, so the fake performs the same translation Notion does
//     rather than echoing the request body back.
//   - **PATCH merges properties**, it does not replace the page.
//   - **POST /v1/pages mints an id** the next query returns.
import { vi } from "vitest";

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

interface FakePage {
  id: string;
  dataSourceId: string;
  lastEditedTime: string;
  /** Stored in Notion's READ shape, never the write shape. */
  properties: Record<string, unknown>;
}

/** Notion's own translation from a written property value to the value it returns. */
function toReadShape(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  const asPlain = (items: unknown): unknown =>
    Array.isArray(items)
      ? items.map((item) => ({
        plain_text: String(((item as { text?: { content?: unknown } }).text ?? {}).content ?? ""),
      }))
      : [];
  if (Array.isArray(v.title)) return { title: asPlain(v.title) };
  if (Array.isArray(v.rich_text)) return { rich_text: asPlain(v.rich_text) };
  if (Array.isArray(v.relation)) {
    return {
      relation: v.relation.map((entry) => ({ id: String((entry as { id?: unknown }).id ?? "") })),
      has_more: false,
    };
  }
  return v;
}

export function makeNotionStore(clock: { now: () => string } = { now: () => "2026-08-06T09:00:00.000Z" }) {
  const pages = new Map<string, FakePage>();
  const requests: RecordedRequest[] = [];
  let minted = 0;

  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

  /** Seeds a page directly, in the READ shape — what a human made in Notion by hand. */
  function seed(dataSourceId: string, id: string, properties: Record<string, unknown>): void {
    pages.set(id, { id, dataSourceId, lastEditedTime: clock.now(), properties });
  }

  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    const body = init?.body === undefined
      ? undefined
      : JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ method, path, body });

    if (method === "POST" && path.endsWith("/query")) {
      const dataSourceId = path.split("/")[3];
      const results = [...pages.values()]
        .filter((page) => page.dataSourceId === dataSourceId)
        .map((page) => ({
          id: page.id,
          last_edited_time: page.lastEditedTime,
          properties: page.properties,
        }));
      return json({ results, has_more: false, next_cursor: null });
    }

    if (method === "POST" && path === "/v1/pages") {
      minted += 1;
      const parent = (body?.parent ?? {}) as { data_source_id?: string };
      const id = `notion-page-${minted}`;
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries((body?.properties ?? {}) as Record<string, unknown>)) {
        properties[key] = toReadShape(value);
      }
      pages.set(id, {
        id, dataSourceId: String(parent.data_source_id ?? ""),
        lastEditedTime: clock.now(), properties,
      });
      return json({ id });
    }

    if (method === "PATCH" && /^\/v1\/pages\/[^/]+$/.test(path)) {
      const id = path.split("/")[3] as string;
      const page = pages.get(id);
      if (page === undefined) return new Response("{\"code\":\"object_not_found\"}", { status: 404 });
      for (const [key, value] of Object.entries((body?.properties ?? {}) as Record<string, unknown>)) {
        page.properties[key] = toReadShape(value);
      }
      page.lastEditedTime = clock.now();
      return json({ id });
    }

    throw new Error(`unexpected ${method} ${path}`);
  });

  return { impl, requests, pages, seed };
}

/** A People row in the READ shape, for seeding a hand-made page. */
export function personPageProps(over: {
  name?: string; email?: string | null; source?: string; sourceId?: string;
}): Record<string, unknown> {
  return {
    Name: { title: [{ plain_text: over.name ?? "" }] },
    Email: { email: over.email === undefined ? null : over.email },
    ...(over.source === undefined ? {} : { Source: { select: { name: over.source } } }),
    ...(over.sourceId === undefined
      ? {}
      : { "Source ID": { rich_text: [{ plain_text: over.sourceId }] } }),
  };
}

/** A Meetings row in the READ shape. */
export function meetingPageProps(over: {
  title?: string; attendees?: string; people?: string[]; peopleTruncated?: boolean;
  peopleUnmatched?: string;
}): Record<string, unknown> {
  return {
    "Meeting Title": { title: [{ plain_text: over.title ?? "" }] },
    Attendees: { rich_text: [{ plain_text: over.attendees ?? "" }] },
    ...(over.people === undefined
      ? {}
      : {
        People: {
          relation: over.people.map((id) => ({ id })),
          has_more: over.peopleTruncated === true,
        },
      }),
    ...(over.peopleUnmatched === undefined
      ? {}
      : { "People Unmatched": { rich_text: [{ plain_text: over.peopleUnmatched }] } }),
  };
}
