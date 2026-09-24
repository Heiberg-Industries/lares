/**
 * Read a Notion page Bendik links to (ORB-289, ORB-286 round 5).
 *
 * Before this, a notion.so link went to the readability worker, which cannot sign in: it got an
 * empty app shell and answered "fetch failed", and Saga told Bendik "the reader is down"
 * (2026-09-14, the Folkepuls follow-up). Notion pages are read through the Notion API instead,
 * using the integration token Saga already holds for meeting follow-ups. Only pages shared with
 * that integration are visible; any other page answers 404, and the error below says so plainly.
 *
 * The HTTP plumbing twins `agent/schedules/meeting-followup.ts` (same API version, the same
 * proxied fetch — eve-saga is sealed, and api.notion.com is reached through squid's
 * `atlas_sources` acl). Duplicated rather than shared, by this codebase's convention for ~20
 * lines of accessor.
 */
import { readFileSync } from "node:fs";

const NOTION_API = "https://api.notion.com";
// Verified against developers.notion.com 2026-08-04 — the version meeting-followup.ts pins.
const NOTION_VERSION = "2026-03-11";
/** What read_url hands the model, at most. Matches the readability worker's PDF cap. */
const MAX_TEXT_CHARS = 200_000;

export class NotionPageUnavailableError extends Error {
  constructor(url: string, detail: string) {
    super(
      `Notion page not readable (${detail}). Either it does not exist, or it is not shared with ` +
        `Saga's Notion integration — Bendik can add the integration under the page's ••• → Connections. ` +
        `Link: ${url}`,
    );
    this.name = "NotionPageUnavailableError";
  }
}

/**
 * The page id in a Notion link, dashed, or null when the URL is not a Notion page link.
 * Handles notion.so / www.notion.so / <workspace>.notion.site, the `Title-<32 hex>` slug, a bare
 * id, and a `?p=<id>` peek link.
 */
export function notionPageIdFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!(host === "notion.so" || host.endsWith(".notion.so") || host.endsWith(".notion.site"))) return null;
  const candidates = [u.searchParams.get("p") ?? "", u.pathname.split("/").pop() ?? ""];
  for (const c of candidates) {
    const hex = c.replace(/-/g, "").match(/([0-9a-f]{32})$/i)?.[1];
    if (hex) {
      const h = hex.toLowerCase();
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
  }
  return null;
}

function readNotionToken(): string {
  const file = process.env["NOTION_TOKEN_FILE"];
  if (file) return readFileSync(file, "utf8").trim();
  const value = process.env["NOTION_TOKEN"];
  if (!value) throw new Error("notion-page: NOTION_TOKEN (or NOTION_TOKEN_FILE) is not set");
  return value;
}

let notionFetchPromise: Promise<typeof fetch> | undefined;

function notionFetch(): Promise<typeof fetch> {
  notionFetchPromise ??= (async () => {
    const proxyUrl = process.env["EGRESS_PROXY_URL"];
    if (proxyUrl === undefined || proxyUrl.trim() === "") return fetch; // local/dev, unsealed
    const { fetch: undiciFetch, ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent(proxyUrl);
    return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
  })();
  return notionFetchPromise;
}

export interface NotionPageDeps {
  fetch?: typeof fetch;
  token?: () => string;
}

async function get(path: string, deps: NotionPageDeps): Promise<Response> {
  const doFetch = deps.fetch ?? (await notionFetch());
  return doFetch(`${NOTION_API}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${(deps.token ?? readNotionToken)()}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
}

function titleOf(page: unknown): string {
  const props = (page as { properties?: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }> }).properties ?? {};
  for (const p of Object.values(props)) {
    if (p?.type === "title") return (p.title ?? []).map((t) => t.plain_text ?? "").join("").trim();
  }
  return "";
}

/** The page's title and its content as markdown, via the Notion API. */
export async function readNotionPage(url: string, deps: NotionPageDeps = {}): Promise<{ title: string; text: string }> {
  const id = notionPageIdFromUrl(url);
  if (!id) throw new NotionPageUnavailableError(url, "not a Notion page link");

  const pageRes = await get(`/v1/pages/${id}`, deps);
  if (pageRes.status === 404 || pageRes.status === 403) throw new NotionPageUnavailableError(url, `Notion answered ${pageRes.status}`);
  if (!pageRes.ok) throw new Error(`notion-page: GET page failed: ${pageRes.status} ${(await pageRes.text()).slice(0, 200)}`);
  const title = titleOf(await pageRes.json()) || "Untitled Notion page";

  const mdRes = await get(`/v1/pages/${id}/markdown`, deps);
  if (!mdRes.ok) throw new Error(`notion-page: GET markdown failed: ${mdRes.status} ${(await mdRes.text()).slice(0, 200)}`);
  const markdown = (await mdRes.json() as { markdown?: unknown }).markdown;
  const text = typeof markdown === "string" ? markdown.trim() : "";
  return { title, text: text.slice(0, MAX_TEXT_CHARS) };
}
