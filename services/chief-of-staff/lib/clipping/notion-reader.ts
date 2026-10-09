/**
 * The Notion reader for clipping (LAR-113): read-only, official SDK, API version pinned,
 * every call bounded in time and in retries, and every failure named.
 *
 * ONE credential: the keeper-managed Notion key, delivered as `NOTION_TOKEN_FILE`. Egress goes
 * through the agent's proxy, exactly as `lib/notion-page.ts`. Nothing here writes to Notion.
 *
 * NEVER A QUIET EMPTY. Every error becomes a `ClippingFailure` with a distinct outcome and a
 * plain owner sentence; a caller cannot mistake "could not look" for "nothing new".
 */
import { readFileSync } from "node:fs";
import {
  Client, ClientErrorCode, isHTTPResponseError, isNotionClientError, APIErrorCode,
} from "@notionhq/client";

import type { ClipSource } from "./record.js";

/** Pinned on purpose (plan 2026-10-09). The SDK default is older and still says `archived`. */
export const NOTION_API_VERSION = "2026-03-11";
export const REQUEST_TIMEOUT_MS = 15_000;
export const RETRY = { maxRetries: 2, maxRetryDelayMs: 10_000 } as const;
/** The whole clipping step, all requests together. */
export const STEP_BUDGET_MS = 90_000;
export const PAGE_SIZE = 100;
export const MAX_PAGES_PER_PASS = 5;
/** Re-read this far behind the watermark, so an edit that landed late is not missed. */
export const OVERLAP_MS = 10 * 60_000;
/** Pages checked for a trash per pass. */
export const MAX_TRASH_CHECKS = 50;

export type ClippingOutcome =
  | "ok" | "not-configured" | "unsupported-source" | "refused" | "not-shared"
  | "schema-mismatch" | "rate-limited" | "unavailable" | "timeout" | "incomplete";

export const FAILURE_OUTCOMES: readonly ClippingOutcome[] = [
  "unsupported-source", "refused", "not-shared", "schema-mismatch",
  "rate-limited", "unavailable", "timeout", "incomplete",
];

/** A failure with its outcome and a sentence the owner can read. Never a vendor body or a token. */
export class ClippingFailure extends Error {
  constructor(
    readonly outcome: ClippingOutcome,
    readonly ownerText: string,
    readonly howToFix: string | null = null,
    cause?: unknown,
  ) {
    super(ownerText, cause === undefined ? undefined : { cause });
    this.name = "ClippingFailure";
  }
}

const FIX = {
  refused: "Check the Notion connection on the Integrations page and test it again.",
  notShared: "Share the clipping database with your Lares connection in Notion (the three dots, then Connections).",
  later: "Nothing to do. Lares tries again at the next digest.",
} as const;

/** Map anything the SDK (or the network) throws to a ClippingFailure. */
export function classifyNotionError(e: unknown): ClippingFailure {
  if (e instanceof ClippingFailure) return e;
  if (isNotionClientError(e) && e.code === ClientErrorCode.RequestTimeout) {
    return new ClippingFailure("timeout", "Notion did not answer in time.", FIX.later);
  }
  if (isHTTPResponseError(e)) {
    const s = e.status;
    if (s === 401 || s === 403) {
      return new ClippingFailure("refused", "Notion refused the connection key.", FIX.refused);
    }
    if (s === 404) {
      return new ClippingFailure("not-shared", "The clipping database is not shared with the Lares connection.", FIX.notShared);
    }
    if (s === 429) {
      return new ClippingFailure("rate-limited", "Notion is limiting requests right now.", FIX.later);
    }
    if (s === 400 && e.code === APIErrorCode.ValidationError) {
      return new ClippingFailure("schema-mismatch", "Notion rejected the clipping query: a column changed.", "Check the clipping database columns on the Integrations page.");
    }
    if (s === 408 || (s >= 500 && s <= 599)) {
      return new ClippingFailure("unavailable", "Notion is unavailable right now.", FIX.later);
    }
    return new ClippingFailure("unavailable", `Notion answered with an unexpected error (${s}).`, FIX.later);
  }
  return new ClippingFailure("unavailable", "Lares could not complete the Notion fetch.", FIX.later, e);
}

/** The slice of the SDK the reader calls. The real `Client` satisfies it; tests pass a fake. */
export interface NotionLike {
  dataSources: {
    retrieve(args: { data_source_id: string }): Promise<unknown>;
    query(args: Record<string, unknown>): Promise<unknown>;
  };
  pages: {
    retrieve(args: { page_id: string }): Promise<unknown>;
  };
}

export function readNotionToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env["NOTION_TOKEN_FILE"];
  try {
    if (file) return readFileSync(file, "utf8").trim() || null;
  } catch { /* unreadable key file: treated as no key */ }
  return env["NOTION_TOKEN"]?.trim() || null;
}

type SdkFetch = NonNullable<ConstructorParameters<typeof Client>[0]>["fetch"];

let proxiedFetch: Promise<SdkFetch> | undefined;
function egressFetch(proxyUrl: string): Promise<SdkFetch> {
  proxiedFetch ??= (async () => {
    const { fetch: undiciFetch, ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent(proxyUrl);
    return ((url: string, init?: object) =>
      undiciFetch(url, { ...init, dispatcher } as never)) as unknown as SdkFetch;
  })();
  return proxiedFetch;
}

export interface MakeClientOptions {
  token: string;
  /** Tests inject a fake network; production uses the agent's egress proxy when it is set. */
  fetch?: SdkFetch;
  proxyUrl?: string;
  timeoutMs?: number;
  retry?: { maxRetries: number; maxRetryDelayMs: number; initialRetryDelayMs?: number };
}

export async function makeNotionClient(o: MakeClientOptions): Promise<Client> {
  const fetchImpl = o.fetch ?? (o.proxyUrl?.trim() ? await egressFetch(o.proxyUrl) : undefined);
  return new Client({
    auth: o.token,
    notionVersion: NOTION_API_VERSION,
    timeoutMs: o.timeoutMs ?? REQUEST_TIMEOUT_MS,
    retry: o.retry ?? RETRY,
    logger: () => {},
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/** Bound a whole step: a pass that overruns fails as a timeout rather than hanging the digest. */
export async function withBudget<T>(budgetMs: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ClippingFailure("timeout", "Fetching clips from Notion took too long.", FIX.later)),
      budgetMs,
    );
  });
  try {
    return await Promise.race([work(), limit]);
  } finally {
    clearTimeout(timer);
  }
}

// --- schema -------------------------------------------------------------------------------

interface SchemaProperty { id: string; name?: string; type: string }

export interface SchemaReport {
  /** Optional mapped columns that are gone or changed type; the import continues without them. */
  warnings: string[];
}

const NOTE_TYPES = new Set(["rich_text"]);
const TAG_TYPES = new Set(["select", "multi_select"]);
const SAVED_TYPES = new Set(["date", "created_time"]);

/**
 * Is the data source still the shape the source row maps? Refuses (throws schema-mismatch) when
 * the URL column is missing or no longer a URL column; an optional column that went missing is a
 * warning, not a stop.
 */
export function checkSchema(dataSource: unknown, source: ClipSource): SchemaReport {
  const props = (dataSource as { properties?: Record<string, SchemaProperty> })?.properties;
  if (!props || typeof props !== "object") {
    throw new ClippingFailure("schema-mismatch", "Notion did not describe the clipping database's columns.", "Test the connection on the Integrations page.");
  }
  const byId = new Map(Object.values(props).filter((p) => p && typeof p === "object").map((p) => [p.id, p]));
  const url = byId.get(source.urlPropertyId);
  if (!url || url.type !== "url") {
    throw new ClippingFailure(
      "schema-mismatch",
      "The URL column was removed or changed type.",
      "Pick the URL column again on the Integrations page.",
    );
  }
  const warnings: string[] = [];
  const optional: [string | null, Set<string>, string][] = [
    [source.notePropertyId, NOTE_TYPES, "note"],
    [source.tagsPropertyId, TAG_TYPES, "tags"],
    [source.savedPropertyId, SAVED_TYPES, "saved-at"],
  ];
  for (const [id, types, label] of optional) {
    if (!id) continue;
    const p = byId.get(id);
    if (!p || !types.has(p.type)) warnings.push(`The ${label} column was removed or changed type; importing without it.`);
  }
  return { warnings };
}

export async function readSchema(client: NotionLike, source: ClipSource): Promise<SchemaReport> {
  try {
    return checkSchema(await client.dataSources.retrieve({ data_source_id: source.dataSourceId }), source);
  } catch (e) {
    throw classifyNotionError(e);
  }
}

// --- changed pages --------------------------------------------------------------------------

export interface ChangedPages {
  pages: unknown[];
  /** True when pages remain beyond the per-pass cap. */
  capped: boolean;
}

/**
 * Pages edited on or after `since`, oldest edit first, at most MAX_PAGES_PER_PASS pages of
 * PAGE_SIZE. A response that says it is incomplete fails the pass instead of being trusted.
 */
export async function queryChangedPages(
  client: NotionLike,
  source: ClipSource,
  since: Date | null,
  opts: { maxPages?: number; pageSize?: number } = {},
): Promise<ChangedPages> {
  const maxPages = opts.maxPages ?? MAX_PAGES_PER_PASS;
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const pages: unknown[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    let res: {
      results?: unknown[]; has_more?: boolean; next_cursor?: string | null;
      request_status?: { type?: string };
    };
    try {
      res = (await client.dataSources.query({
        data_source_id: source.dataSourceId,
        page_size: pageSize,
        sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
        ...(since ? { filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: since.toISOString() } } } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
      })) as typeof res;
    } catch (e) {
      throw classifyNotionError(e);
    }
    if (res.request_status?.type === "incomplete") {
      throw new ClippingFailure(
        "incomplete",
        "Notion said the answer was incomplete, so Lares did not trust it.",
        FIX.later,
      );
    }
    for (const r of res.results ?? []) {
      if ((r as { object?: string })?.object === "page") pages.push(r);
    }
    if (!res.has_more || !res.next_cursor) return { pages, capped: false };
    cursor = res.next_cursor;
  }
  return { pages, capped: true };
}

// --- one page: trashed? ---------------------------------------------------------------------

/** `true` when the page is in the trash or gone (404); `false` when it still exists. */
export async function isPageGone(client: NotionLike, pageId: string): Promise<boolean> {
  try {
    const p = (await client.pages.retrieve({ page_id: pageId })) as { in_trash?: boolean };
    return p?.in_trash === true;
  } catch (e) {
    const f = classifyNotionError(e);
    if (f.outcome === "not-shared") return true; // 404 on a page we saw before: deleted or unshared
    throw f;
  }
}
