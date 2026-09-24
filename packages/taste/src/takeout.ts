// packages/taste/src/takeout.ts — Google Takeout "Saved" list CSV → taste place entries.
//
// This is the ONE manual feed the taste layer ships with (ORB-97: no connectors, no sync jobs —
// Bendik exports his saved lists from Google Takeout and uploads them in the console). The
// parser is lifted from Marcel's own `services/travel/lib/taste.ts`, which has read these
// exact files in production since old Marcel — same hand-rolled CSV reader, same coordinate
// extraction, both proven against real Takeout exports. It lives here now because the console
// is the importer and Marcel stops reading CSVs entirely once the store is the source of truth.
//
// No geocoding call in v1: a saved place whose Google Maps URL carries no coordinates simply
// arrives without them, and matches by city instead. Paying an external API to fill that gap is
// a decision for a later version, not something to do quietly during an import.
import type { PlaceEntry } from "./index.js";

/**
 * Hand-rolled CSV reader: handles quoted fields with embedded commas and doubled-quote escaping
 * (`""` -> `"`), which is all Takeout CSVs use. A dependency would buy nothing here and would be
 * the only dependency this package has.
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/**
 * Browser-resolved export: `Title, Note, Latitude, Longitude, URL`.
 *
 * THE STANDARD PATH for coordinates (Bendik, 2026-08-17). Google's current Takeout format puts a
 * feature id in the saved URL — `!1s0x89c2595f07acd2e3:0xbf4202b1312b5cf1` — and no coordinates
 * at all; measured across his real export, 0 of 864 rows carried a lat/lon. That feature id is
 * NOT a Places place id either: Places API (New) answers "is not valid", and Geocoding rejects
 * it too (both verified against the live key). So the API route cannot resolve these at any
 * price.
 *
 * What does work, exactly and for nothing: load each saved URL in a browser and read the pin out
 * of Google's own redirect. That produced 42/42 exact matches on the NYC list against ground
 * truth. Text Search remains available as a last-resort fallback for a URL that will not resolve,
 * but it is fuzzy — it matches a NAME, not the pin Bendik actually saved — so it is the
 * exception, never the default.
 *
 * Rows whose coordinates are blank or unparseable are kept WITHOUT them rather than dropped: a
 * place with no pin still matches its trip by city, and losing it entirely would be worse.
 */
export function parseResolvedTakeoutCsv(csvText: string, listName: string): PlaceEntry[] {
  const rows = parseCsvRows(csvText);
  const places: PlaceEntry[] = [];
  for (let i = 1; i < rows.length; i++) {
    const [title, note, lat, lon, url] = rows[i]!;
    if (!title || title.trim() === "") continue;
    const latN = Number(lat);
    const lonN = Number(lon);
    const hasCoords =
      lat !== undefined && lat.trim() !== "" && lon !== undefined && lon.trim() !== "" &&
      Number.isFinite(latN) && Number.isFinite(lonN) && Math.abs(latN) <= 90 && Math.abs(lonN) <= 180;
    places.push({
      type: "place",
      name: title.trim(),
      ...(hasCoords ? { lat: latN, lon: lonN } : {}),
      ...(url ? { url } : {}),
      sourceList: listName,
      ...(note && note.trim() !== "" ? { note: note.trim() } : {}),
    });
  }
  return places;
}

/**
 * The saved place's stable identity, out of its Google Maps URL.
 *
 * Every Takeout row carries `!1s<hex>:<hex>` — Google's feature id for that exact pin. It is
 * the ONE field that survives everything else changing: a place can be renamed, re-noted,
 * re-pinned or re-exported and the feature id stays put. Names do not have that property (two
 * Supremes, three Roberta's, one of them spelled with a curly apostrophe), so a re-upload keyed
 * on names cannot tell "renamed" from "removed and added".
 *
 * Returns undefined for a URL that carries none — a shortlink, a hand-written entry, a pasted
 * list. Those fall back to name-keyed identity, which is the best available and is fine for
 * entries that were never Takeout rows in the first place.
 */
export function featureIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** Identity for diffing a re-upload: the feature id when there is one, else the name. */
export function placeKey(place: Pick<PlaceEntry, "name" | "url">): string {
  return featureIdFromUrl(place.url) ?? `name:${place.name.trim().toLowerCase()}`;
}

/** Takeout embeds the pin's coordinates in the saved URL, in one of two shapes. */
export function extractCoords(url: string): { lat?: number; lon?: number } {
  const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) return { lat: Number(at[1]), lon: Number(at[2]) };
  const q = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (q) return { lat: Number(q[1]), lon: Number(q[2]) };
  return {};
}

/**
 * Parse one Takeout list export into place entries tagged with the list they came from.
 *
 * `listName` becomes `sourceList`, which is half the upsert key (`entryFilename`) — so
 * re-uploading the same list under the same name overwrites its entries rather than duplicating
 * them, and uploading it under a DIFFERENT name deliberately keeps both. That is the whole
 * duplicate-prevention story; there is no separate dedupe pass.
 *
 * The header row is skipped by position, not by name: Takeout's columns are title, note, URL, and
 * the header text is localised. A row with no title is skipped — an unnamed place is unreachable.
 */
export function parseTakeoutCsv(csvText: string, listName: string): PlaceEntry[] {
  const rows = parseCsvRows(csvText);
  const places: PlaceEntry[] = [];
  for (let i = 1; i < rows.length; i++) {
    const [title, note, url] = rows[i]!;
    if (!title || title.trim() === "") continue;
    const { lat, lon } = extractCoords(url ?? "");
    places.push({
      type: "place",
      name: title.trim(),
      ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
      ...(url ? { url } : {}),
      sourceList: listName,
      ...(note && note.trim() !== "" ? { note: note.trim() } : {}),
    });
  }
  return places;
}
