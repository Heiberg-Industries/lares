/**
 * The digest's readability seam — eve-saga's own worker client, shaped to `ReadabilityClient`.
 *
 * Replaces the old runtime's `makeReadabilityClient` (`lib/adapters/digest/enrich.ts`), which
 * was a second HTTP client for the same worker. eve-saga already owns that contract in
 * `@lares/agent-kit/readability-client`: auth, the error taxonomy, and egress through squid. Two clients
 * would be two places to keep all three correct.
 *
 * TWO BEHAVIOURS THIS MUST PRESERVE, both easy to lose in a port:
 *
 * 1. **The 300-character floor.** The old client returned `null` for anything shorter, so a
 *    stub page or a paywall interstitial never counted as enrichment and the item was
 *    classified on its original body. `readUrl` has no such notion — without this check the
 *    digest would quietly start enriching short pages it used to leave alone.
 * 2. **Never throw — return `null`.** `enrichItem` calls the client WITHOUT a try/catch and
 *    treats `null` as "no enrichment, use the original body". `readUrl` throws
 *    (`ReadabilityUnavailableError`, `ReadabilityNoContentError`), so a bare wiring would let
 *    one unreachable URL abort the whole item — and `runDigest`'s per-item catch would record
 *    it as an ERROR rather than filing the note from its own text. Degrade here, deliberately.
 */
import { readUrl } from "@lares/agent-kit/readability-client";
import { MIN_ARTICLE_CHARS, type ReadabilityClient } from "./enrich.js";

export function digestReadability(readerFn: typeof readUrl = readUrl): ReadabilityClient {
  return async (url: string) => {
    try {
      const article = await readerFn(url);
      if (!article?.text || article.text.length < MIN_ARTICLE_CHARS) return null;
      return { title: article.title || "Untitled", text: article.text };
    } catch {
      // Any failure — worker down, no extractable content, blocked egress — is "not enriched",
      // never a thrown error. See behaviour 2 above.
      return null;
    }
  };
}
