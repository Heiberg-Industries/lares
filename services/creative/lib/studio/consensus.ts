// Atlas-backed consensus source for the studio pipeline.
// Searches the brief by KEYWORD TOKENS (brand names, topics) rather than as one literal
// string — a brief like "wedges for Murmur" must hit the `murmur` note, which never
// contains the phrase "wedges for murmur" verbatim. Hits are unioned across tokens and
// ranked by score, so the most-relevant brand note rises to the top.
//
// FILENAME MATCHES DOMINATE. A token matching a note's FILENAME (e.g. "zero7" → zero7.md)
// is a strong brand signal and scores far higher than a body match — otherwise a rich brief's
// generic words ("marketing", "platform", "new") match every note and bury the actual brand
// note (the live failure: a Zero7 brief grounded on murmur.md). The brand note must lead.
import { basename } from "node:path";

const FILENAME_BONUS = 10; // a token in the note's filename outweighs many body matches

// Grounding = CURATED BRAND CONTEXT only. The agent's own saved spreads land in _inbox/
// (gated proposals); feeding them back as consensus would make the studio diverge from its
// OWN past ideas — an echo chamber. The premise is NEW ideas grounded in what the business is,
// not re-runs of saved ones. So _inbox/ is excluded from the consensus (it stays a write target).
const EXCLUDED_PREFIXES = ["_inbox/"];
const isBrandContext = (path: string) => !EXCLUDED_PREFIXES.some((p) => path.startsWith(p));

// Short fillers that should not drive a vault search (they match everything / nothing useful).
const STOPWORDS = new Set([
  "the", "for", "and", "with", "you", "your", "our", "are", "not", "but", "give",
  "some", "any", "what", "how", "ideas", "idea", "angles", "angle", "ways", "way",
  "that", "this", "from", "into", "about", "around", "would", "could", "should",
]);

function tokenize(brief: string): string[] {
  const toks = brief
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(toks)];
}

export function makeBrainConsensus(
  deps: { search: (q: string) => Promise<string[]>; read: (path: string) => Promise<string> },
  opts: { topN?: number; maxChars?: number } = {},
): (brief: string) => Promise<string> {
  const topN = opts.topN ?? 3;
  const maxChars = opts.maxChars ?? 4000;
  return async (brief: string) => {
    const tokens = tokenize(brief);
    // Fall back to the whole brief if tokenization stripped everything (e.g. a 2-char brand).
    const queries = tokens.length ? tokens : [brief.trim().toLowerCase()].filter(Boolean);

    const score = new Map<string, number>(); // path → relevance score
    for (const q of queries) {
      const hits = (await deps.search(q).catch(() => [])).filter(isBrandContext);
      for (const path of hits) {
        const bonus = basename(path).toLowerCase().includes(q) ? FILENAME_BONUS : 0;
        score.set(path, (score.get(path) ?? 0) + 1 + bonus); // +1 body/path match, +bonus if filename
      }
    }
    const ranked = [...score.entries()]
      .sort((a, b) => b[1] - a[1]) // highest score first; stable for ties (insertion order)
      .map(([path]) => path);

    if (ranked.length === 0) return "(no prior material found in the Atlas for this brief)";
    const bodies = await Promise.all(ranked.slice(0, topN).map((p) => deps.read(p).catch(() => "")));
    return bodies.filter(Boolean).join("\n\n---\n\n").slice(0, maxChars);
  };
}
