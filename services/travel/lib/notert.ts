// lib/notert.ts — appends a fact into a trip's trip.md "## Notert" section.
//
// Ported verbatim from old Marcel's `appendNotert` (`services/marcel/bin/marcel.ts:199-218`).
// Extracted into its own file (Fix Wave B, Finding 2) so both `agent/tools/remember.ts` (the
// model-facing tool, Task 6) and `agent/channels/telegram.ts`'s group `husk:` shortcut (Finding
// 2 — old Marcel's `bin/marcel.ts:608-616`, previously unreachable in this port) write the exact
// same section the exact same way, rather than two copies of a 20-line splice drifting apart.
//
import { TripStore, type Trip } from "./trip-store.js";

const TRIP_MD = "trip.md";
const NOTERT_HEADING = "## Notert";

export function appendNotert(store: TripStore, trip: Trip, fact: string): void {
  const existing = store.read(trip, TRIP_MD);
  const lines = existing.length ? existing.split("\n") : [];
  const idx = lines.findIndex((l) => l.trim() === NOTERT_HEADING);
  if (idx === -1) {
    const base = existing.replace(/\s+$/, "");
    const block = `${NOTERT_HEADING}\n- ${fact}`;
    store.write(trip, TRIP_MD, (base ? `${base}\n\n` : "") + block + "\n");
    return;
  }
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  lines.splice(end, 0, `- ${fact}`);
  store.write(trip, TRIP_MD, lines.join("\n"));
}
