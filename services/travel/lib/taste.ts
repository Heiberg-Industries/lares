// lib/taste.ts — pure matching and summarising over the taste store's entries.
//
// ORB-100 rewrote this file's inputs, not its ideas. It used to parse Google Takeout CSVs out of
// `<MARCEL_DATA_ROOT>/taste/google-maps-lists/` itself; the store is now `/srv/taste` (console-
// fed, `@lares/taste`-shaped, read via lib/taste-store.ts), so the CSV reader moved to the
// package where the console imports with it, and this file kept what it was actually for:
// deciding which saved places are near a trip, and rendering them small enough to sit in a
// prompt.
//
// Still pure — no fs, no model. Callers own reading.
import { type ListEntry, type PlaceEntry } from "@lares/taste";

/** Per ORB-100: ~30 km of the trip's destination. Tighter than the 60 km the CSV era used,
 *  because a coordinate that far out is a different trip, not a nearby option. */
export const TRIP_RADIUS_KM = 30;

/** Caps exist so a long saved list cannot quietly eat the context window. Overflow is COUNTED
 *  and stated ("… og N til"), never silently dropped — Marcel saying "that's all you saved"
 *  when it isn't would be a truthfulness failure, not a formatting one. */
const NEARBY_CAP = 80;
const LIST_CAP = 12;
const LIST_ITEM_CAP = 8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export function normalizePlaceName(s: string): string {
  // ø/æ/œ/ß have NO canonical decomposition — NFD alone leaves them unfolded, so an
  // ASCII-transliterated spelling ("Notteroy") would never match "Nøtterøy". Fold them
  // explicitly before stripping combining marks.
  return s
    .toLowerCase()
    .replace(/ø/g, "o").replace(/æ/g, "ae").replace(/œ/g, "oe").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Which saved places belong to a trip.
 *
 * TWO ways to match, because the store has two kinds of place. Takeout imports carry
 * coordinates, so they match by distance. Pasted lists do not — Takeout is the only feed with
 * coordinates and v1 makes no geocoding call — so those match on their `city` against the trip's
 * destination name. A place with neither is not matched at all rather than guessed at.
 */
export function nearTrip(
  places: readonly PlaceEntry[],
  destination: { name: string; lat: number; lon: number },
  radiusKm: number = TRIP_RADIUS_KM,
): PlaceEntry[] {
  const city = normalizePlaceName(destination.name);
  return places.filter((p) => {
    if (p.lat !== undefined && p.lon !== undefined) {
      return haversineKm(destination, { lat: p.lat, lon: p.lon }) <= radiusKm;
    }
    if (p.city === undefined || city === "") return false;
    const theirs = normalizePlaceName(p.city);
    return theirs !== "" && (theirs === city || theirs.includes(city) || city.includes(theirs));
  });
}

/** One line per place: name, where it came from, and the note if there is one. Never the file. */
export function savedSummary(places: readonly PlaceEntry[], cap = NEARBY_CAP): string {
  const shown = places.slice(0, cap);
  const lines = shown.map((p) => {
    const from = p.sourceList ? ` (${p.sourceList})` : "";
    const note = p.note ? ` — ${p.note.replace(/\s+/g, " ").trim()}` : "";
    return `- ${p.name}${from}${note}`;
  });
  if (places.length > cap) lines.push(`… og ${places.length - cap} til`);
  return lines.join("\n");
}

/**
 * The whole-taste digest: playlists, dishes, notes — enough for Marcel to recommend in Bendik's
 * direction without carrying every file. An injected digest rather than an on-demand lookup tool
 * (ORB-100 left the choice open): the whole non-place store is a few dozen short lines, so a tool
 * round-trip would cost a turn to fetch what fits in the prompt outright.
 */
export function tasteDigest(lists: readonly ListEntry[], cap = LIST_CAP): string {
  const shown = lists.slice(0, cap);
  const lines = shown.map((l) => {
    const items = l.items.slice(0, LIST_ITEM_CAP).join(", ");
    const more = l.items.length > LIST_ITEM_CAP ? `, … (+${l.items.length - LIST_ITEM_CAP})` : "";
    return `- ${l.name} (${l.type}): ${items}${more}`;
  });
  if (lists.length > cap) lines.push(`… og ${lists.length - cap} lister til`);
  return lines.join("\n");
}

/** Cross-reference a discovery hit against Bendik's saved places — NAMES ONLY. Takeout saves
 *  originate in Google Maps, so names align with Places displayName; coordinate-only matching
 *  would ⭐ the neighbor two doors down. Containment needs ≥4 chars per side so "Bar" can never
 *  claim "Barcelona Tapas". */
export function findSavedMatch(name: string, saved: readonly PlaceEntry[]): PlaceEntry | undefined {
  const n = normalizePlaceName(name);
  if (!n) return undefined;
  for (const p of saved) {
    const pn = normalizePlaceName(p.name);
    if (!pn) continue;
    if (pn === n) return p;
    if (pn.length >= 4 && n.length >= 4 && (n.includes(pn) || pn.includes(n))) return p;
  }
  return undefined;
}
