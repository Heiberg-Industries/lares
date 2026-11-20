/**
 * The `[confirm: …]` markers a draft carries where the owner still has to decide something
 * (a date, a price, a scope) that the thread has not agreed. The rule that makes a drafter write
 * them is `noCommitmentsClause` in the compose contract; this is the one reader, so the approval
 * card and the triage ping list them the same way.
 *
 * Pure: no I/O. Never throws; text without a marker returns [].
 */

const MARKER = /\[confirm:\s*([^\]\n]{1,200}?)\s*\]/gi;

/** Every distinct marker question in `text`, in order of first appearance. */
export function extractConfirmMarkers(text: unknown): string[] {
  if (typeof text !== "string" || text === "") return [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MARKER)) {
    const q = m[1]!.trim();
    if (q !== "") seen.add(q);
  }
  return [...seen];
}

/** "Needs your answer: a; b" or null when there is nothing to answer. */
export function needsYourAnswer(text: unknown): string | null {
  const q = extractConfirmMarkers(text);
  return q.length === 0 ? null : `Needs your answer: ${q.join("; ")}`;
}
