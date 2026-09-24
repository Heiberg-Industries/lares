import type { TurnKey } from "@lares/agent-kit/origin-taint";

import { classifyInbound } from "./detect.js";
import { extractAttachment, parseFrontmatter, stripFrontmatter } from "./extract.js";

export type ReadabilityClient = (url: string) => Promise<{ title: string; text: string } | null>;

/** The article-length floor below which a fetch does not count as enrichment. Exported
 *  because `lib/digest/readability.ts` re-implements the client against eve-saga's own
 *  worker and MUST apply the same threshold — dropping it would silently start enriching
 *  short pages the old service left alone. */
export const MIN_ARTICLE_CHARS = 300;

// `makeReadabilityClient` is deliberately NOT ported. eve-saga already owns the readability
// worker's HTTP contract in `@lares/agent-kit/readability-client` (auth, error taxonomy, egress via
// squid); a second client would be a second place to keep that correct. The adapter that
// satisfies `ReadabilityClient` from it lives in `lib/digest/readability.ts`.

export async function enrichItem(
  item: { path: string; body: string },
  client: ReadabilityClient,
): Promise<{ path: string; body: string; enriched: boolean }> {
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
  const article = await client(url);
  if (!article) return { ...item, enriched: false };
  const body = `${article.text}\n\n<!-- source: ${url} -->`;
  return { path: item.path, body, enriched: true };
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
}): (item: { path: string; body: string }) => Promise<{ path: string; body: string; enriched: boolean }> {
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
