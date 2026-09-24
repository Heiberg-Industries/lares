/** "ny" / "endret" — what a recent upload did to this entry (ORB-110).
 *
 * No "use client": it holds no state and no handler, so it renders on the server in the browse
 * view and gets bundled along when the row (which IS a client component) uses it. Living in its
 * own file is what lets the page's legend and the row itself show the SAME badge — the legend
 * explaining a differently-styled badge would be its own small lie. */
// Type-only, so the bundler never follows this into `taste-browse`'s filesystem imports.
import type { Badge } from "../lib/taste-browse";

export const badgeStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: ".04em",
  textTransform: "uppercase",
  padding: "1px 5px",
  borderRadius: 3,
  border: "1px solid var(--signal)",
  color: "var(--signal)",
  whiteSpace: "nowrap",
} as const;

export function FreshBadge({ badge }: { badge: Badge }) {
  return <span style={badgeStyle} title={badge.title}>{badge.text}</span>;
}
