// services/console/lib/taste-import.ts — re-uploading a saved list is a DIFF, not a dump.
//
// The first version of this import only ever added or overwrote. That is wrong in three ways a
// curated store cannot afford:
//
//   - a place Bendik REMOVED from his Google list stayed in the store forever, and Marcel kept
//     recommending it;
//   - a re-upload of the raw Takeout export (no coordinates — Google stopped putting them in)
//     would have wiped the pins a browser-resolved upload had already established;
//   - names are not identity. Two Supremes, three Roberta's, one spelled with a curly
//     apostrophe. Keyed on names, a rename is indistinguishable from a delete plus an add.
//
// So an upload is diffed against what the store already holds FOR THAT LIST, keyed on the saved
// URL's feature id (`@lares/taste`'s `placeKey`) — the one field that survives renaming and
// re-exporting. Lists not in the batch are not read, not written, and not touched: uploading
// "NYC" must never have consequences for "Paris".
import { assignFilenames, serializeEntry, type PlaceEntry } from "@lares/taste";
import { placeKey } from "@lares/taste/takeout";

import { listDomain, type StoredEntry } from "./taste-store";

export interface ListDiff {
  listName: string;
  /** In the upload, not in the store. */
  added: PlaceEntry[];
  /** In both — the stored entry is replaced, but see `carryCoordinates`. */
  updated: PlaceEntry[];
  /** In the store under this list, absent from the upload: Bendik removed it in Google. */
  removed: Array<StoredEntry & { entry: PlaceEntry }>;
  /** Entries whose coordinates came from the STORE rather than the upload, because the upload
   *  had none. Counted so the summary can say a raw re-upload kept its pins. */
  keptCoordinates: number;
  /** Every file the store held for this list AT PLAN TIME. Captured here, once, because the
   *  apply step writes into the same directory — re-reading it afterwards would see its own
   *  new files and mistake them for pre-existing ones. */
  priorFiles: string[];
  /** What the store held for this list, by identity, at plan time (ORB-110). The apply step
   *  needs it to answer two questions the counts cannot: what this entry's `importedAt` was
   *  (it must survive a re-import — a place does not become newly-imported because its list was
   *  uploaded again), and whether anything about it ACTUALLY changed. */
  priorByKey: Map<string, PlaceEntry>;
}

function isPlace(stored: StoredEntry): stored is StoredEntry & { entry: PlaceEntry } {
  return stored.entry !== null && stored.entry.type === "place";
}

/** Everything the store currently holds for one source list. Unparseable files are ignored
 *  here rather than treated as removals — deleting a file we could not read is not something an
 *  import should decide on its own. */
export function storedForList(listName: string): Array<StoredEntry & { entry: PlaceEntry }> {
  return listDomain("places")
    .filter(isPlace)
    .filter((s) => s.entry.sourceList === listName);
}

/**
 * Plans one list's upload against what is already stored.
 *
 * Coordinate preservation is the subtle half: an entry present in both keeps the STORE's
 * coordinates whenever the upload has none. That is what lets a plain Takeout re-export be
 * uploaded safely on top of a browser-resolved one — the pins survive, and only the fields the
 * upload actually carries get refreshed.
 */
export function diffList(listName: string, incoming: readonly PlaceEntry[]): ListDiff {
  const existing = storedForList(listName);
  const byKey = new Map(existing.map((s) => [placeKey(s.entry), s]));
  const seen = new Set<string>();

  const added: PlaceEntry[] = [];
  const updated: PlaceEntry[] = [];
  let keptCoordinates = 0;

  for (const place of incoming) {
    const key = placeKey(place);
    seen.add(key);
    const prior = byKey.get(key);
    if (!prior) {
      added.push(place);
      continue;
    }
    let merged = place;
    if (place.lat === undefined && prior.entry.lat !== undefined) {
      merged = { ...place, lat: prior.entry.lat, lon: prior.entry.lon };
      keptCoordinates++;
    }
    updated.push(merged);
  }

  const removed = existing.filter((s) => !seen.has(placeKey(s.entry)));
  return {
    listName,
    added,
    updated,
    removed,
    keptCoordinates,
    priorFiles: existing.map((s) => s.file),
    priorByKey: new Map([...byKey].map(([key, s]) => [key, s.entry])),
  };
}

/** The fields that make an entry the thing it is — everything except the stamps that record when
 *  we last wrote it. Comparing these is what separates "Bendik changed this place" from "Bendik
 *  re-uploaded the list it happens to sit in". */
function contentOf(place: PlaceEntry): string {
  return JSON.stringify([
    place.name, place.lat, place.lon, place.city, place.country, place.url, place.sourceList, place.note,
  ]);
}

/**
 * Records WHEN, on top of the diff's what.
 *
 * `diffList` classifies by identity: an entry present in both the upload and the store lands in
 * `updated` whether or not one byte of it differs. That is the right answer for the diff (it
 * drives the upsert, and the file is rewritten either way) and the wrong answer for a badge —
 * re-uploading an unchanged 126-place list would flag all 126 as "endret", which is a badge that
 * tells Bendik nothing. So the stamp is decided on content, not on classification:
 *
 *  - no prior at all       -> `importedAt = now`. It is genuinely new.
 *  - prior, content differs -> keep its `importedAt`, set `updatedAt = now`.
 *  - prior, content same    -> carry both stamps through untouched. Nothing happened.
 *
 * A prior entry from before ORB-110 has no `importedAt` to carry, and does not acquire one here:
 * claiming it arrived today would be a lie the browse view would then badge.
 *
 * This runs at APPLY time rather than inside `diffList`, because import-time geocoding rewrites
 * the surviving entries in between — a coordinate found at commit is exactly the kind of change
 * that should read as "endret", and a stamp decided before it would have missed it.
 */
function stamp(place: PlaceEntry, prior: PlaceEntry | undefined, now: string): PlaceEntry {
  if (!prior) return { ...place, importedAt: now };
  const carried = prior.importedAt === undefined ? {} : { importedAt: prior.importedAt };
  if (contentOf(prior) === contentOf(place)) {
    return { ...place, ...carried, ...(prior.updatedAt === undefined ? {} : { updatedAt: prior.updatedAt }) };
  }
  return { ...place, ...carried, updatedAt: now };
}

export interface ApplyResult {
  listName: string;
  added: number;
  updated: number;
  removed: number;
  keptCoordinates: number;
  /** Of the `updated` entries, how many actually differed from what was stored (ORB-110). Zero
   *  is the interesting value and is reported rather than inferred: "re-uploaded and nothing had
   *  changed" and "re-uploaded and something quietly failed to apply" look identical otherwise. */
  changed: number;
}

export interface ApplyDeps {
  write(file: string, body: string): void;
  remove(file: string): void;
}

/**
 * Writes one planned list, then deletes whatever this list used to own and no longer does.
 *
 * That second step covers two cases with one rule — any prior file of this list that is not in
 * the newly written set goes. A place removed from the Google list is one. A place RENAMED in
 * Google is the other: its feature id survives, so it is an update, but its filename changed, and
 * without this the old file would linger as a ghost recommending a name Bendik no longer uses.
 *
 * Scoped strictly to this list's own prior files, so uploading "NYC" can never delete anything
 * belonging to "Paris".
 */
export function applyListDiff(diff: ListDiff, deps: ApplyDeps, now: Date = new Date()): ApplyResult {
  const at = now.toISOString();
  const stamped = [...diff.added, ...diff.updated].map((place) =>
    stamp(place, diff.priorByKey.get(placeKey(place)), at),
  );
  const changed = stamped.filter((p) => p.updatedAt === at).length;

  // Filenames are assigned on the STAMPED entries, but nothing in `entryFilename` reads a stamp,
  // so this names exactly what the unstamped batch would have named.
  const assigned = assignFilenames(stamped);
  for (const { entry, file } of assigned) deps.write(file, serializeEntry(entry));

  const wanted = new Set(assigned.map((a) => a.file));
  for (const file of diff.priorFiles) {
    if (!wanted.has(file)) deps.remove(file);
  }

  return {
    listName: diff.listName,
    added: diff.added.length,
    updated: diff.updated.length,
    removed: diff.removed.length,
    keptCoordinates: diff.keptCoordinates,
    changed,
  };
}
