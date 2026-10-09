/**
 * The neutral clip record (LAR-113). Any saved-link source maps into this; nothing here knows
 * more about Notion than "a page has typed properties". Pure code: no network, no model.
 *
 * WHERE A CLIP LANDS follows the SOURCE's owner and visibility, never the page's content
 * (docs/plans/2026-10-09-notion-clipping.md section 8). `mapPageToClip` copies both from the
 * source row and ignores every column of the page for that purpose.
 */
import { classifyInbound } from "../digest/detect.js";

export interface ClipSource {
  id: string;
  kind: "notion";
  /** The Notion data source (the table inside a database) the clips are read from. */
  dataSourceId: string;
  /** Mapped columns are stored by Notion property id, not name, so a rename does not break. */
  urlPropertyId: string;
  notePropertyId: string | null;
  tagsPropertyId: string | null;
  savedPropertyId: string | null;
  /** `organisation`, or one member's register id. */
  owner: string;
  visibility: "shared" | "private";
}

export interface ClipRecord {
  sourceId: string;
  sourceKind: "notion";
  sourceContainer: string;
  sourceItemId: string;
  sourceRevision: string;
  /** The saved link as written. */
  url: string;
  /** Normalised link for duplicate checks within one inbox. */
  urlKey: string;
  title: string;
  note: string | null;
  tags: string[];
  capturedAt: string;
  owner: string;
  visibility: "shared" | "private";
}

export type MappedPage =
  | { kind: "clip"; clip: ClipRecord }
  | { kind: "skip"; reason: "no-link"; sourceItemId: string; sourceRevision: string }
  | { kind: "trashed"; sourceItemId: string; sourceRevision: string };

const TRACKING_PARAM = /^(utm_.*|fbclid|gclid)$/i;
const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * Lower-case scheme and host, no fragment, no `utm_*` / `fbclid` / `gclid`, no trailing slash,
 * no default port. Returns null for anything that is not an http(s) web link.
 */
export function normaliseUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  u.hash = "";
  if (u.port === DEFAULT_PORT[u.protocol]) u.port = "";
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  }
  const search = u.searchParams.toString();
  u.search = search ? `?${search}` : "";
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** `_inbox/clip-<sourceId>-<pageid>.md`: derived, so a crash and re-run rewrites the same file. */
export function clipInboxPath(sourceId: string, sourceItemId: string): string {
  const page = sourceItemId.replace(/-/g, "");
  if (!SAFE_ID.test(sourceId) || !SAFE_ID.test(page)) throw new Error("clipping: unsafe id for an inbox path");
  return `_inbox/clip-${sourceId}-${page}.md`;
}

/**
 * The link of a saved item: the mapped URL column when it holds a web link, otherwise a title
 * that is a single link (the digest's own detector decides, `lib/digest/detect.ts`).
 */
export function pickLink(urlColumn: string | null | undefined, title: string): string | null {
  const col = (urlColumn ?? "").trim();
  if (col && normaliseUrl(col)) return col;
  const c = classifyInbound(title);
  if (c.kind === "link" && normaliseUrl(c.url)) return c.url;
  return null;
}

// A page as the API returns it, narrowed to what is read. Anything else is ignored.
interface RawProperty { id?: string; type?: string; [k: string]: unknown }
interface RawPage {
  id: string;
  created_time: string;
  last_edited_time: string;
  in_trash?: boolean;
  properties?: Record<string, RawProperty>;
}

function byId(page: RawPage, id: string | null): RawProperty | undefined {
  if (!id) return undefined;
  return Object.values(page.properties ?? {}).find((p) => p?.id === id);
}

const plain = (items: unknown): string =>
  Array.isArray(items) ? items.map((t) => String((t as { plain_text?: string })?.plain_text ?? "")).join("") : "";

function titleOf(page: RawPage): string {
  const t = Object.values(page.properties ?? {}).find((p) => p?.type === "title");
  return plain(t?.["title"]).trim();
}

function tagsOf(p: RawProperty | undefined): string[] {
  if (!p) return [];
  if (p.type === "multi_select" && Array.isArray(p["multi_select"])) {
    return (p["multi_select"] as { name?: string }[]).map((o) => String(o?.name ?? "").trim()).filter(Boolean);
  }
  if (p.type === "select" && p["select"]) {
    const name = String((p["select"] as { name?: string }).name ?? "").trim();
    return name ? [name] : [];
  }
  return [];
}

function savedOf(page: RawPage, p: RawProperty | undefined): string {
  if (p?.type === "date" && p["date"]) {
    const start = (p["date"] as { start?: string }).start;
    if (start) return start;
  }
  if (p?.type === "created_time" && typeof p["created_time"] === "string") return p["created_time"] as string;
  return page.created_time;
}

/**
 * Where a page's link would come from: the mapped URL column, the title (when it is a single
 * link), or nowhere. Used by "Test" to say how many links the URL column supplied.
 */
export function linkOrigin(page: RawPage, source: ClipSource): "column" | "title" | null {
  const urlProp = byId(page, source.urlPropertyId);
  const col = urlProp?.type === "url" ? ((urlProp["url"] as string | null) ?? "").trim() : "";
  if (col && normaliseUrl(col)) return "column";
  return pickLink(null, titleOf(page)) ? "title" : null;
}

/** Map one Notion page to a clip, a counted skip (no link) or a trashed marker. */
export function mapPageToClip(page: RawPage, source: ClipSource): MappedPage {
  const rev = page.last_edited_time;
  if (page.in_trash === true) return { kind: "trashed", sourceItemId: page.id, sourceRevision: rev };

  const title = titleOf(page);
  const urlProp = byId(page, source.urlPropertyId);
  const url = pickLink(urlProp?.type === "url" ? (urlProp["url"] as string | null) : null, title);
  const urlKey = url ? normaliseUrl(url) : null;
  if (!url || !urlKey) return { kind: "skip", reason: "no-link", sourceItemId: page.id, sourceRevision: rev };

  const noteProp = byId(page, source.notePropertyId);
  const note = noteProp?.type === "rich_text" ? plain(noteProp["rich_text"]).trim() : "";

  return {
    kind: "clip",
    clip: {
      sourceId: source.id,
      sourceKind: source.kind,
      sourceContainer: source.dataSourceId,
      sourceItemId: page.id,
      sourceRevision: rev,
      url,
      urlKey,
      title: title || url,
      note: note || null,
      tags: tagsOf(byId(page, source.tagsPropertyId)),
      capturedAt: savedOf(page, byId(page, source.savedPropertyId)),
      // From the source row, never from the page (plan section 8, rule 5).
      owner: source.owner,
      visibility: source.visibility,
    },
  };
}

/** One line, no fence: a value must not be able to add or close frontmatter. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * The `_inbox` note: metadata only, same privacy posture as the Karakeep notes (no article text).
 * `url:` is what the digest's enrich step reads.
 */
export function renderClipNote(c: ClipRecord): string {
  const url = /^\S+$/.test(c.url) ? c.url : (new URL(c.url).href);
  const tags = c.tags.map(oneLine).filter(Boolean);
  return [
    `---`,
    `url: ${url}`,
    `title: ${oneLine(c.title)}`,
    `source: ${c.sourceKind}`,
    `saved: ${oneLine(c.capturedAt)}`,
    `notion_page: ${c.sourceItemId}`,
    `source_revision: ${c.sourceRevision}`,
    `owner: ${oneLine(c.owner)}`,
    `visibility: ${c.visibility}`,
    `lares_origin: synced`,
    ...(tags.length ? [`tags: ${tags.join(", ")}`] : []),
    `---`,
    ``,
    c.note ?? "",
    ``,
  ].join("\n");
}
