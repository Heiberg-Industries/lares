// A pure test for "this venue quote is a placeholder, not a real price." A stuck ask of ~1.00 with
// no real bid is Kalshi/Polymarket's "no offer" marker; fed into de-vig it inflates the implied total
// and crushes every other outcome's fair. Detect it so the producer can exclude it from the book.
export const PLACEHOLDER_ASK = 0.999;

export function isPlaceholderQuote(ask: number | undefined, bid?: number | undefined): boolean {
  if (ask === undefined || !Number.isFinite(ask) || ask <= 0) return true;
  if (ask < PLACEHOLDER_ASK) return false;
  // ask is ~1.0: only real if there's a genuine bid below the placeholder line.
  return bid === undefined || !Number.isFinite(bid) || bid >= PLACEHOLDER_ASK || bid <= 0;
}
