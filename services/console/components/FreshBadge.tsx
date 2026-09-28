/** The recent-import label, shared by the legend and each entry row.
 *
 * No "use client": it holds no state and no handler, so it renders on the server in the browse
 * view and gets bundled along when the row (which IS a client component) uses it. Living in its
 * own file is what lets the page's legend and the row itself show the SAME badge — the legend
 * explaining a differently-styled badge would be its own small lie. */
// Type-only, so the bundler never follows this into `taste-browse`'s filesystem imports.
import type { Badge } from "../lib/taste-browse";
import { StatusBadge } from "@lares/ui/patterns";

export function FreshBadge({ badge }: { badge: Badge }) {
  return <StatusBadge title={badge.title}>{badge.text}</StatusBadge>;
}
