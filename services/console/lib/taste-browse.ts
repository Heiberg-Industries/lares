// services/console/lib/taste-browse.ts — what the Taste browse view SHOWS (ORB-110).
//
// With ~860 places across 25 lists, a flat table is a pile, not a tool. This file holds the
// filtering, sorting and freshness rules; `app/taste/page.tsx` holds only the markup that renders
// them. The split is so these rules can be tested at all — a server component that reads the
// filesystem is not something a unit test can interrogate, and "the filter works" is exactly the
// claim that has to be verified rather than assumed.
//
// Pure: it is handed already-read entries and answers questions about them. No fs, no request.
import { isPlace, type TasteEntry } from "@lares/taste";

import type { StoredEntry } from "./taste-store";

/** How long an entry counts as fresh. Seven days is one upload session's worth of memory: long
 *  enough that Bendik can come back next weekend and still see what he added, short enough that
 *  the badge means "recently" rather than decorating the whole store forever. */
export const FRESH_DAYS = 7;

export interface Filters {
  list: string;
  city: string;
  country: string;
  q: string;
  sort: "navn" | "nyeste";
}

/** Everything arrives as a string off the query string; anything unrecognised falls back to the
 *  unfiltered default rather than erroring — a hand-edited URL should show the store, not a
 *  stack trace. */
export function readFilters(params: Record<string, string | string[] | undefined>): Filters {
  const one = (key: string): string => {
    const v = params[key];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  };
  return {
    list: one("list"),
    city: one("city"),
    country: one("country"),
    q: one("q"),
    sort: one("sort") === "nyeste" ? "nyeste" : "navn",
  };
}

export function isFiltered(f: Filters): boolean {
  return [f.list, f.city, f.country, f.q].some((v) => v !== "");
}

/** The fields an entry may be filtered on. A playlist has no city, so a city filter hides it —
 *  which is the honest answer to "show me what I have in New York". */
function facetsOf(entry: TasteEntry | null): { list?: string; city?: string; country?: string } {
  if (!entry) return {};
  return {
    ...(entry.sourceList === undefined ? {} : { list: entry.sourceList }),
    ...(isPlace(entry) ? { city: entry.city, country: entry.country } : {}),
  };
}

export function matches(stored: StoredEntry, f: Filters): boolean {
  const facets = facetsOf(stored.entry);
  if (f.list !== "" && facets.list !== f.list) return false;
  if (f.city !== "" && facets.city !== f.city) return false;
  if (f.country !== "" && facets.country !== f.country) return false;
  if (f.q !== "") {
    // The FILENAME is searched alongside the name so an unparseable file — which has no name at
    // all — stays findable in the one view where it can be deleted.
    const hay = `${stored.entry?.name ?? ""} ${stored.file}`.toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

/** Distinct values for one facet across the WHOLE store, so a dropdown keeps offering the option
 *  you are currently filtered to instead of collapsing to the one thing you can still see. */
export function optionsFor(all: readonly StoredEntry[], key: "list" | "city" | "country"): string[] {
  const seen = new Set<string>();
  for (const stored of all) {
    const value = facetsOf(stored.entry)[key];
    if (value !== undefined && value !== "") seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, "nb"));
}

/** When the store last wrote this entry, if it recorded it at all. */
export function touchedAt(entry: TasteEntry | null): string | undefined {
  if (!entry) return undefined;
  const stamps = [entry.updatedAt, entry.importedAt].filter((s): s is string => s !== undefined);
  return stamps.sort().at(-1);
}

export interface Badge {
  text: string;
  /** The exact date, for the tooltip — the badge says "recently", this says when. */
  title: string;
  fresh: boolean;
}

/** "ny" for an entry an import added, "endret" for one it changed — and nothing at all once it
 *  is older than `FRESH_DAYS`, or for the 862 entries imported before anything recorded a date.
 *  Absence is not staleness; it is "we never knew", and inventing a date to badge it would be a
 *  worse answer than showing none. */
export function badgeFor(entry: TasteEntry | null, now: number): Badge | undefined {
  const at = touchedAt(entry);
  if (!entry || at === undefined) return undefined;
  if ((now - Date.parse(at)) / 86_400_000 > FRESH_DAYS) return undefined;
  const changed = entry.updatedAt !== undefined;
  return {
    text: changed ? "endret" : "ny",
    title: `${changed ? "Endret" : "Lagt inn"} ${at.slice(0, 10)}`,
    fresh: true,
  };
}

const byName = (a: StoredEntry, b: StoredEntry) =>
  (a.entry?.name ?? a.file).localeCompare(b.entry?.name ?? b.file, "nb");

export function sortRows(rows: readonly StoredEntry[], sort: Filters["sort"]): StoredEntry[] {
  if (sort === "navn") return [...rows].sort(byName);
  // Recency, newest first. An entry with no stamp is not "oldest" — it is unknown, and unknown
  // sorts to the bottom rather than claiming a date it never had.
  return [...rows].sort((a, b) => {
    const at = touchedAt(a.entry);
    const bt = touchedAt(b.entry);
    if (at === bt) return byName(a, b);
    if (at === undefined) return 1;
    if (bt === undefined) return -1;
    return bt.localeCompare(at);
  });
}

/** The second column: enough to recognise the entry, never the whole file. */
export function detailFor(stored: StoredEntry): string {
  const entry = stored.entry;
  if (!entry) return "";
  if (isPlace(entry)) {
    return [
      [entry.city, entry.country].filter(Boolean).join(", "),
      entry.lat === undefined ? "uten koordinater" : `${entry.lat.toFixed(4)}, ${entry.lon!.toFixed(4)}`,
      entry.sourceList && `fra «${entry.sourceList}»`,
    ].filter(Boolean).join(" · ");
  }
  return `${entry.type} · ${entry.items.length} linjer`;
}
