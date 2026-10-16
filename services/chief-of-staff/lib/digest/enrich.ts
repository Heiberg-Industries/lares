import type { TurnKey } from "@lares/agent-kit/origin-taint";

import { classifyInbound } from "./detect.js";
import { extractAttachment, parseFrontmatter, stripFrontmatter } from "./extract.js";

export type ReadabilityClient = (url: string) => Promise<{ title: string; text: string } | null>;

/** The article-length floor below which a fetch does not count as enrichment. Exported
 *  because `lib/digest/readability.ts` re-implements the client against the chief of staff's own
 *  worker and MUST apply the same threshold — dropping it would silently start enriching
 *  short pages the old service left alone. */
export const MIN_ARTICLE_CHARS = 300;

// `makeReadabilityClient` is deliberately NOT ported. The chief of staff already owns the readability
// worker's HTTP contract in `@lares/agent-kit/readability-client` (auth, error taxonomy, egress via
// squid); a second client would be a second place to keep that correct. The adapter that
// satisfies `ReadabilityClient` from it lives in `lib/digest/readability.ts`.

/** A web page the reader opened for a saved link. */
export interface FetchedArticle {
  url: string;
  title: string;
  text: string;
}

export interface EnrichedItem {
  path: string;
  body: string;
  enriched: boolean;
  /**
   * Set when the item is a saved link the reader could open. The page travels BESIDE the item's
   * own body (the owner's clip note), never in place of it, so filing can keep both.
   */
  article?: FetchedArticle;
}

/**
 * The body the digest classifies and files when nothing is set up to file articles: the page text
 * with a provenance comment, as `enrichItem` used to return it.
 */
export function legacyEnrichedBody(article: FetchedArticle): string {
  return `${article.text}\n\n<!-- source: ${article.url} -->`;
}

export async function enrichItem(
  item: { path: string; body: string },
  client: ReadabilityClient,
): Promise<EnrichedItem> {
  // Prefer the URL stored in frontmatter (written by CaptureSink.writeLink).
  // A real capture note has `url:` in its frontmatter AND a `url\nlabel` body —
  // classifyInbound on the full file would see two URLs and return `conversation`.
  const fm = parseFrontmatter(item.body);
  let url: string | undefined;
  if (fm.url) {
    url = fm.url;
  } else {
    // Fallback: hand-written bare-URL note (no frontmatter) — strip any frontmatter
    // then run classifier so existing unit tests continue to pass.
    const stripped = stripFrontmatter(item.body);
    const c = classifyInbound(stripped);
    if (c.kind === "link") url = c.url;
  }

  if (!url) return { ...item, enriched: false };
  const page = await client(url);
  if (!page) return { ...item, enriched: false };
  return { ...item, enriched: true, article: { url, title: page.title, text: page.text } };
}

/**
 * Build the enrich function for the digest runner.
 *
 * Dispatch order (exactly one branch fires per item):
 * 1. Attachment breadcrumb (has `attachment:` in frontmatter) → extractAttachment
 * 2. Bare-URL link body → URL readability enrichment (if client provided)
 * 3. Plain text → untouched
 */
export function makeEnrich(opts: {
  readability?: ReadabilityClient | null;
  readFile: (rel: string) => Promise<Buffer>;
  /**
   * The turn this pass runs in, when there is one — threaded straight to `extractAttachment` so
   * an attachment it extracts taints that turn (W3A-s5). The digest schedule's own call site has
   * no turn to pass; a future interactive caller wires this without the extractor's own callers
   * needing to change again.
   */
  turn?: TurnKey;
}): (item: { path: string; body: string }) => Promise<EnrichedItem> {
  return async (item) => {
    // Branch 1: attachment breadcrumb
    const att = await extractAttachment({ breadcrumbBody: item.body, readFile: opts.readFile, turn: opts.turn });
    if (att !== null) {
      const filename = att.rel.split("/").pop() ?? att.rel;
      const body = att.kind === "image"
        ? `image, no text yet — ${filename}`
        : att.text;
      return { path: item.path, body, enriched: true };
    }

    // Branch 2: bare-URL link
    if (opts.readability) {
      return enrichItem(item, opts.readability);
    }

    // Branch 3: plain text
    return { ...item, enriched: false };
  };
}
