// services/chief-of-staff/lib/person/anchor.ts
// CORE — vendor-neutral.
// Ported verbatim from services/agent-runtime/lib/person/anchor.ts (Task 8) — logic unchanged.
import type { DatedItem, EngagementEvent } from "./types.js";

/**
 * The most recent thing Bendik actually did with this person, or null if he never has.
 *
 * This single value is what lets one rule produce both shapes the spec asks for: with a
 * recent anchor almost nothing is fresh and the answer is three lines; with an old anchor
 * nearly everything is fresh and the answer is a dossier; with no anchor at all the person
 * is a stranger and everything is new. Nothing classifies the person, so there is no mode
 * to misclassify.
 */
export function contactAnchor(events: EngagementEvent[]): EngagementEvent | null {
  let latest: EngagementEvent | null = null;
  for (const e of events) {
    if (!latest || e.at.getTime() > latest.at.getTime()) latest = e;
  }
  return latest;
}

/**
 * Split dated material into what happened after the anchor and what came before.
 *
 * Strictly after: an item sharing a timestamp with the anchor IS the anchor (or arrived
 * with it) and is not news. With no anchor, everything is fresh — a stranger has no old news.
 */
export function partitionByAnchor<T extends DatedItem>(
  items: T[],
  anchor: Date | null,
): { fresh: T[]; history: T[] } {
  if (!anchor) return { fresh: [...items], history: [] };
  const cut = anchor.getTime();
  const fresh: T[] = [];
  const history: T[] = [];
  for (const i of items) (i.at.getTime() > cut ? fresh : history).push(i);
  return { fresh, history };
}
