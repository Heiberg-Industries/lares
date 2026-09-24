// lib/taste-store.ts — Marcel's READ-ONLY view of the fleet taste store (ORB-97/100).
//
// `/srv/taste` is Bendik's own curated store: saved places, playlists, food notes. The console
// writes it; Marcel mounts it `:ro` and never writes a byte (ORB-97's access model — the mount
// flag is the enforcement, this file is just the reader). It replaces the CSV loader Marcel
// carried over from old Marcel (`taste/google-maps-lists/*.csv`), which is gone as of ORB-100 —
// one store, one shape, one parser (`@lares/taste`, shared with the console so the two cannot
// drift).
//
// NOT to be confused with `<MARCEL_DATA_ROOT>/taste/preferences.md`, which is Marcel's OWN
// learned taste — written by his dream/promote schedules, still writable, still where it was.
// One is what Bendik saved; the other is what Marcel worked out. They stay separate.
//
// NOTHING here throws. An unmounted store, an unreadable folder, a file someone hand-edited into
// nonsense — each degrades to "nothing from that source", because the mount must never be
// load-bearing: a trip whose taste store is missing has to behave exactly like a trip before this
// feature existed (pinned in tests/taste-store.test.ts).
import fs from "node:fs";
import path from "node:path";

import { isPlace, parseEntry, type ListEntry, type PlaceEntry } from "@lares/taste";

/** Domains that are LISTS rather than pins — the "whole taste" half. `places` is read
 *  separately because it is the only domain with coordinates. */
const LIST_DOMAINS = ["music", "food", "notes"] as const;

export function tasteRoot(): string {
  return process.env["TASTE_ROOT"] ?? "/srv/taste";
}

function readDomain(root: string, domain: string): unknown[] {
  const dir = path.join(root, domain);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const entries: unknown[] = [];
  for (const file of files) {
    try {
      entries.push(parseEntry(fs.readFileSync(path.join(dir, file), "utf8")));
    } catch (err) {
      // One bad file must not cost the other two hundred. Logged, not thrown — the console's
      // browse view is where a broken file is visible and fixable.
      console.error(`eve-marcel: skipping unreadable taste file ${domain}/${file} —`, err);
    }
  }
  return entries;
}

export class TasteStore {
  private root: string;

  constructor(root: string = tasteRoot()) {
    this.root = root;
  }

  /** Every saved place, with or without coordinates. */
  places(): PlaceEntry[] {
    return readDomain(this.root, "places").filter((e): e is PlaceEntry => isPlace(e as never));
  }

  /** Playlists, dishes and notes — the non-place half, used for general recommendation flavour. */
  lists(): ListEntry[] {
    return LIST_DOMAINS.flatMap((d) => readDomain(this.root, d)).filter(
      (e): e is ListEntry => !isPlace(e as never),
    );
  }
}
