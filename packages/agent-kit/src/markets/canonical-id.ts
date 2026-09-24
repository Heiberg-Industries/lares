// Known same-market slug aliases (Polymarket lists a few markets under two slugs). Map alias → canonical.
const ALIASES: Record<string, string> = {
  "which-continent-will-win-the-world-cup": "which-continent-will-win",
  "world-cup-team-to-advance-to-knockout-stages": "world-cup-team-to-advance-to-knockout",
};

export function canonicalMarketId(slug: string): string {
  const s = ALIASES[slug] ?? slug;
  return ("wc26-" + s.replace(/^world-cup-/, "").replace(/-2026\d+$/, "")).slice(0, 60);
}
