/**
 * Karakeep sync — pulls new "save for later" bookmarks from a self-hosted Karakeep
 * instance into the Brain `_inbox` as metadata-only notes (link + title + tags, NO
 * article body), so the existing digest enriches + files them. Read-only against
 * Karakeep; the only writes are new `_inbox` notes. See docs/research/2026-06-19-clipper-tool-sweep.md.
 */

export interface KarakeepBookmark {
  id: string;
  createdAt: string;
  title: string | null;
  note: string | null;
  tags?: { name: string }[];
  content?: { type?: string; url?: string; title?: string };
}

export interface KarakeepPage {
  bookmarks: KarakeepBookmark[];
  nextCursor: string | null;
}

export interface KarakeepClient {
  listBookmarks(opts?: { cursor?: string; limit?: number }): Promise<KarakeepPage>;
}

/** A read-only Karakeep REST client (GET /api/v1/bookmarks, Bearer auth, metadata only). */
export function makeKarakeepClient(deps: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): KarakeepClient {
  const f = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl.replace(/\/+$/, "");
  return {
    async listBookmarks(opts) {
      const params = new URLSearchParams({ sortOrder: "desc", limit: String(opts?.limit ?? 50) });
      if (opts?.cursor) params.set("cursor", opts.cursor);
      const res = await f(`${base}/api/v1/bookmarks?${params.toString()}`, {
        headers: { Authorization: `Bearer ${deps.token}`, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`karakeep listBookmarks failed: HTTP ${res.status}`);
      const json = (await res.json()) as KarakeepPage;
      return { bookmarks: json.bookmarks ?? [], nextCursor: json.nextCursor ?? null };
    },
  };
}

/**
 * Map a LINK bookmark to a metadata-only `_inbox` note. Returns null for non-link
 * bookmarks (text/asset) or links missing a URL. The `url:` frontmatter is what the
 * digest's enrich step reads to fetch the readable text — we deliberately store NO
 * article body here (link + metadata only keeps the personal-data surface small).
 */
export function bookmarkToInboxNote(b: KarakeepBookmark): { relPath: string; body: string } | null {
  if (b.content?.type !== "link") return null;
  const url = b.content.url;
  if (!url) return null;
  const title = b.title ?? b.content.title ?? url;
  const tags = (b.tags ?? []).map((t) => t.name).filter(Boolean);
  const fm = [
    `---`,
    `url: ${url}`,
    `title: ${title}`,
    `source: karakeep`,
    `saved: ${b.createdAt}`,
    `karakeep_id: ${b.id}`,
    ...(tags.length ? [`tags: ${tags.join(", ")}`] : []),
    `---`,
    ``,
    b.note ?? "",
    ``,
  ].join("\n");
  return { relPath: `_inbox/karakeep-${b.id}.md`, body: fm };
}

export interface SeenStore {
  isSeen(id: string): Promise<boolean>;
  markSeen(id: string): Promise<void>;
}

export interface KarakeepSyncDeps {
  client: KarakeepClient;
  seen: SeenStore;
  writeNote(o: { relPath: string; body: string }): Promise<void>;
  log?: (m: string) => void;
}

/**
 * Pull newest-first and write each previously-unseen LINK bookmark into `_inbox`.
 * Stops once a whole page is already-seen (we've caught up) or after `maxPages`.
 * Returns the number of notes written.
 */
export async function syncKarakeep(
  deps: KarakeepSyncDeps,
  opts?: { maxPages?: number; pageLimit?: number },
): Promise<number> {
  const maxPages = opts?.maxPages ?? 10;
  const pageLimit = opts?.pageLimit ?? 50;
  let cursor: string | undefined;
  let written = 0;
  for (let page = 0; page < maxPages; page++) {
    const { bookmarks, nextCursor } = await deps.client.listBookmarks({ cursor, limit: pageLimit });
    if (bookmarks.length === 0) break;
    let freshOnPage = 0;
    for (const b of bookmarks) {
      if (await deps.seen.isSeen(b.id)) continue;
      freshOnPage++;
      const note = bookmarkToInboxNote(b);
      if (!note) { await deps.seen.markSeen(b.id); continue; } // non-link: mark so we skip it forever
      await deps.writeNote(note);
      await deps.seen.markSeen(b.id); // mark only AFTER a successful write (a hiccup → retried next run)
      written++;
    }
    if (freshOnPage === 0) break; // whole page already seen → caught up
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  if (written > 0) deps.log?.(`karakeep: imported ${written} new bookmark(s) to _inbox`);
  return written;
}

/** Postgres-backed seen store (dedupe across runs). Thin SQL over an injected pool/query. */
export function makePgSeenStore(db: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }): SeenStore & {
  ensure(): Promise<void>;
} {
  return {
    async ensure() {
      await db.query(
        `CREATE TABLE IF NOT EXISTS karakeep_seen (id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())`,
      );
    },
    async isSeen(id) {
      const r = await db.query(`SELECT 1 FROM karakeep_seen WHERE id = $1`, [id]);
      return r.rows.length > 0;
    },
    async markSeen(id) {
      await db.query(`INSERT INTO karakeep_seen (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [id]);
    },
  };
}
