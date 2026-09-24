"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { parseResolvedTakeoutCsv, parseTakeoutCsv } from "@lares/taste/takeout";
import { serializeEntry, type ListEntry, type PlaceEntry, type TasteDomain, type TasteEntry } from "@lares/taste";

import { applyListDiff, diffList, storedForList, type ApplyResult } from "../../lib/taste-import";
import { pinFromFeatureIdOnly, placesApiKey, resolveMissingCoordinates } from "../../lib/geocode";
import { auditStoredPins } from "../../lib/pin-audit";
import { metresBetween } from "@lares/taste/s2";
import { derivePlaceName } from "../../lib/city-lookup";

import { verify } from "../../lib/auth";
import {
  assertDomain,
  deleteEntry,
  listDomain,
  parsePastedLines,
  writeEntries,
  writeRawEntry,
  type WriteResult,
} from "../../lib/taste-store";

// Every page is behind the session middleware, but a server action is its own entry point —
// same belt-and-braces `requireUser` every other action file here uses (app/actions/voice.ts).
async function requireUser(): Promise<string> {
  const email = await verify((await cookies()).get("lares_session")?.value);
  if (!email) throw new Error("unauthenticated");
  return email;
}

export interface UploadedList {
  listName: string;
  csvText: string;
  /** Used both as the entries' `city` and, when a row has no coordinates, as the Text Search
   *  bias. Optional — a list that names no single city simply has none. */
  city?: string;
  /** Operator-supplied country for the whole list (ORB-110). Filter facet only — it is never
   *  looked up anywhere and never biases the coordinate search, which already has the city. */
  country?: string;
}

export interface ListPreview {
  listName: string;
  added: number;
  updated: number;
  removed: number;
  /** Names being removed, so a surprising deletion is visible BEFORE confirming. */
  removedNames: string[];
  /** Rows arriving with coordinates already (a browser-resolved export). */
  withCoords: number;
  /** Rows that would keep the pin the store already holds. */
  keepsCoords: number;
  /** Rows with no pin from either side — they would need Text Search at commit time. */
  needsLookup: number;
}

/** One CSV becomes entries. A browser-resolved export (Title, Note, Latitude, Longitude, URL)
 *  is detected by its header and preferred; anything else is read as a plain Takeout export. */
function parseUpload(list: UploadedList): PlaceEntry[] {
  const header = list.csvText.slice(0, list.csvText.indexOf("\n") + 1).toLowerCase();
  const resolved = header.includes("latitude") && header.includes("longitude");
  const places = resolved
    ? parseResolvedTakeoutCsv(list.csvText, list.listName)
    : parseTakeoutCsv(list.csvText, list.listName);
  const city = list.city?.trim();
  const country = list.country?.trim();
  if (!city && !country) return places;
  return places.map((p) => ({ ...p, ...(city ? { city } : {}), ...(country ? { country } : {}) }));
}

function requireListName(name: string): string {
  const listName = name.trim();
  if (listName === "") throw new Error("gi listen et navn — den er n\u00f8kkelen som knytter opplastingen til det som alt ligger der");
  return listName;
}

/**
 * Plans the batch, writing nothing. Each list is diffed against what the store already holds
 * FOR THAT LIST, so the preview can show +/~/− per list before anything is committed — and a
 * list that is not in the batch is never even read.
 */
export async function previewTakeout(input: { lists: UploadedList[] }): Promise<ListPreview[]> {
  await requireUser();
  return input.lists.map((list) => {
    const listName = requireListName(list.listName);
    const incoming = parseUpload({ ...list, listName });
    const diff = diffList(listName, incoming);
    const surviving = [...diff.added, ...diff.updated];
    return {
      listName,
      added: diff.added.length,
      updated: diff.updated.length,
      removed: diff.removed.length,
      removedNames: diff.removed.map((r) => r.entry.name),
      withCoords: incoming.filter((p) => p.lat !== undefined).length,
      keepsCoords: diff.keptCoordinates,
      needsLookup: surviving.filter((p) => p.lat === undefined).length,
    };
  });
}

export interface CommitResult extends ApplyResult {
  /** Confirmed pins found by the biased Text Search at import time (rung 2). */
  geocoded: number;
  /** Pins taken from the saved URL's own feature id, flagged `approx` (rung 3), with why the
   *  exact match did not happen. */
  approximate: Array<{ name: string; reason: string }>;
  /** Places left without a pin at all, and why — never guessed at. */
  unresolved: Array<{ name: string; reason: string }>;
}

/**
 * Ceiling on billed searches per committed list.
 *
 * Bendik's largest single list is ~100 places, so 250 leaves generous headroom while making a
 * runaway import impossible: worst case one list costs a few dollars, not a few hundred. The
 * 2026-08-14 leak is the reason a number is written down here at all.
 */
const MAX_SEARCHES_PER_LIST = 250;

/**
 * The middle of what a saved list already holds — the search bias for an entry that carries no
 * feature id of its own (ORB-116).
 *
 * The MEDIAN of each axis rather than the mean, because a list with one pin in the wrong country
 * would drag a mean into the sea while leaving a median exactly where the list actually is. Given
 * that wrong pins are the defect this whole evening is about, that is not a hypothetical.
 */
function listCentroid(entries: readonly PlaceEntry[]): { lat: number; lon: number } | undefined {
  const pinned = entries.filter((p) => p.lat !== undefined && p.lon !== undefined && !p.approx);
  if (pinned.length === 0) return undefined;
  const mid = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  return { lat: mid(pinned.map((p) => p.lat!)), lon: mid(pinned.map((p) => p.lon!)) };
}

/**
 * City and country for entries that have a pin but no name for where it is (ORB-116).
 *
 * Operator-supplied values always win: the form's city/country are an override, not a default, so
 * a list Bendik has deliberately labelled keeps his label. Everything else is derived offline from
 * the coordinate.
 */
function withDerivedPlaceNames(entries: readonly PlaceEntry[]): PlaceEntry[] {
  return entries.map((entry) => {
    if (entry.city !== undefined && entry.country !== undefined) return entry;
    const derived = derivePlaceName(entry);
    if (!derived) return entry;
    return {
      ...entry,
      ...(entry.city === undefined ? { city: derived.city } : {}),
      ...(entry.country === undefined ? { country: derived.country } : {}),
    };
  });
}

export async function commitTakeout(input: { lists: UploadedList[] }): Promise<CommitResult[]> {
  await requireUser();
  const apiKey = placesApiKey();
  const results: CommitResult[] = [];

  for (const list of input.lists) {
    const listName = requireListName(list.listName);
    const city = list.city?.trim() ?? "";
    const incoming = parseUpload({ ...list, listName });

    // Coordinates, in order of preference: the upload's own (browser-resolved), then the pin the
    // store already holds (applied by diffList), then the ladder — a biased Text Search accepted
    // only on an exact name match near the right place, falling back to the saved URL's own
    // decoded cell. Without a Places key the offline rungs still run, so an unkeyed import now
    // pins nearly everything rather than nothing.
    let geocoded = 0;
    let approximate: Array<{ name: string; reason: string }> = [];
    const unresolved: Array<{ name: string; reason: string }> = [];

    const diff = diffList(listName, incoming);
    const surviving = [...diff.added, ...diff.updated];
    const missing = surviving.filter((p) => p.lat === undefined);

    if (missing.length > 0) {
      const fallbackBias = listCentroid([...storedForList(listName).map((s) => s.entry), ...surviving]);
      const outcome = apiKey
        ? await resolveMissingCoordinates(surviving, city, {
            apiKey,
            maxSearches: MAX_SEARCHES_PER_LIST,
            ...(fallbackBias ? { fallbackBias } : {}),
          })
        : pinFromFeatureIdOnly(surviving);
      geocoded = outcome.resolved;
      approximate = outcome.approximate;
      unresolved.push(...outcome.unresolved);
      // The resolver preserves order, so its output splits back along the same added/updated
      // boundary it was concatenated on. The boundary is captured BEFORE `diff.added` is
      // reassigned, so the second slice can never read a length the first one just changed.
      const addedCount = diff.added.length;
      diff.added = outcome.entries.slice(0, addedCount);
      diff.updated = outcome.entries.slice(addedCount);
    }

    // City and country last, so entries that only just gained a pin get named too.
    diff.added = withDerivedPlaceNames(diff.added);
    diff.updated = withDerivedPlaceNames(diff.updated);

    const applied = applyListDiff(diff, {
      write: (file, body) => writeRawEntry(file, body),
      remove: (file) => deleteEntry("places", file),
    });

    // One line per list in `docker logs`: before this, a commit left no server-side trace at all,
    // so "did it actually save?" had no answer anywhere but the browser tab (ORB-116).
    console.log(
      `[taste] import "${listName}": +${applied.added} ~${applied.updated} -${applied.removed}; ` +
        `${geocoded} exact, ${approximate.length} approx, ${unresolved.length} without a pin`,
    );

    results.push({ ...applied, geocoded, approximate, unresolved });
  }

  revalidatePath("/taste");
  return results;
}

/** Which OKF type a pasted list becomes, by the folder it was aimed at. */
const PASTE_TYPE: Record<Exclude<TasteDomain, "places">, ListEntry["type"]> = {
  music: "playlist",
  food: "dish",
  notes: "note",
};

/**
 * Freeform paste.
 *
 * Two shapes, because the two are genuinely different things:
 *
 *  - music / food / notes → ONE file per pasted list, entries as markdown list items. A playlist
 *    is a list; splitting it into thirty files would say something false about it.
 *  - places → one PLACE entry per line. A pasted restaurant list stored as a single list file
 *    would be invisible to Marcel's per-trip proximity matching (ORB-100 matches per place, by
 *    coordinates or by city), which is the entire reason to save it. Pasted places carry no
 *    coordinates — Takeout is the feed that has those — so the form offers a city, which is what
 *    the city-string fallback matches on.
 */
export async function commitPaste(input: {
  domain: string;
  name: string;
  text: string;
  city?: string;
  country?: string;
}): Promise<WriteResult> {
  await requireUser();
  const domain = assertDomain(input.domain);
  const name = input.name.trim();
  if (name === "") throw new Error("gi listen et navn");

  const items = parsePastedLines(input.text);
  if (items.length === 0) throw new Error("fant ingen linjer å lagre");

  const city = input.city?.trim();
  const country = input.country?.trim();
  const entries: TasteEntry[] =
    domain === "places"
      ? items.map(
          (item): PlaceEntry => ({
            type: "place",
            name: item,
            ...(city ? { city } : {}),
            ...(country ? { country } : {}),
            sourceList: name,
          }),
        )
      // No sourceList on a pasted list: the list's own name IS its identity, so re-pasting under
      // the same name updates it in place instead of leaving two files behind.
      : [{ type: PASTE_TYPE[domain], name, items }];

  const result = writeEntries(entries);
  revalidatePath("/taste");
  return result;
}

export interface CountryResult {
  listName: string;
  /** Entries rewritten because their country actually differed. */
  changed: number;
  /** Entries left alone because they already said this. Reported so "already done" is
   *  distinguishable from "did nothing and did not say why" — the same reason `changed` exists
   *  on an import result. */
  alreadySet: number;
}

/**
 * Sets `country` on every entry of one saved list, in place.
 *
 * The import form carries country for anything uploaded from now on, but the store already holds
 * 862 places across 25 lists that predate the field, and re-exporting 25 CSVs from Google to
 * attach one word each is not a reasonable ask. This is ORB-110's sanctioned maintenance path.
 *
 * It rewrites each entry at the FILE NAME the store already gave it rather than re-deriving one:
 * nothing here changes a name, a list membership or an identity, so nothing here may move a file.
 * That also keeps it clear of the import's diff/upsert semantics entirely.
 *
 * No stamp is touched. Attaching a country is bookkeeping about the list, not a change to the
 * place, and badging 126 entries "endret" for it would drown the signal the badge exists for.
 */
export async function setListCountry(input: { listName: string; country: string }): Promise<CountryResult> {
  await requireUser();
  const listName = requireListName(input.listName);
  const country = input.country.trim();
  if (country === "") throw new Error("skriv inn et land");

  let changed = 0;
  let alreadySet = 0;
  for (const stored of storedForList(listName)) {
    if (stored.entry.country === country) {
      alreadySet++;
      continue;
    }
    writeRawEntry(stored.file, serializeEntry({ ...stored.entry, country }));
    changed++;
  }

  revalidatePath("/taste");
  return { listName, changed, alreadySet };
}

export async function removeEntry(input: { domain: string; file: string }): Promise<void> {
  await requireUser();
  deleteEntry(assertDomain(input.domain), input.file);
  revalidatePath("/taste");
}

export interface PinRepairRow {
  name: string;
  sourceList?: string;
  /** How far the old pin sat from the place's own decoded cell — the size of the disagreement. */
  wrongBy: number;
  /** `exact` — a confirmed match replaced the pin. `kept` — no confirmed match, so the stored pin
   *  was LEFT ALONE and the disagreement is reported for a human to settle. */
  outcome: "exact" | "kept";
  /** What happened at rung 2, in plain Norwegian, for the decision above. */
  reason?: string;
}

export interface PinRepairResult {
  /** Pins the store's own saved links contradict. */
  found: number;
  /** How many were replaced with a confirmed match (rung 2). */
  exact: number;
  /** How many were left exactly as they were, because nothing confirmed a better answer. */
  kept: number;
  /** Billed searches made. */
  searches: number;
  rows: PinRepairRow[];
}

/**
 * Finds stored pins that the saved link disagrees with, and re-derives them through the ladder.
 *
 * THE CASE THIS EXISTS FOR (2026-08-17): 51 of 928 pins were a same-named place on another
 * continent — the residue of a coordinate backfill that fell back from resolving each saved URL to
 * searching its name. Nothing downstream could see it: a wrong pin looks exactly like a right one
 * in the browse view, and Marcel simply never fires near a place that is 9,000 km away.
 *
 * `dryRun` is the default on purpose. This rewrites entries Bendik did not just upload, so the
 * first thing it should ever do is show its work.
 */
export async function repairContradictedPins(input?: { dryRun?: boolean }): Promise<PinRepairResult> {
  await requireUser();
  const dryRun = input?.dryRun ?? true;
  const apiKey = placesApiKey();
  const suspects = auditStoredPins();

  const rows: PinRepairRow[] = [];
  let exact = 0;
  let kept = 0;
  let searches = 0;

  for (const suspect of suspects) {
    // Hand the ladder the entry with its disputed pin REMOVED, so it takes the same path a fresh
    // import would — rung 2 biased by the decoded cell, rung 3 falling back to it. Re-deriving
    // through the real resolver is the point: a repair that used its own private logic would be
    // one more thing that can disagree with the importer.
    const { lat: _lat, lon: _lon, ...pinless } = suspect.entry;
    const outcome = apiKey
      ? await resolveMissingCoordinates([pinless], suspect.entry.city ?? "", { apiKey, maxSearches: 1 })
      : pinFromFeatureIdOnly([pinless]);
    searches += outcome.searches;

    // THE THIRD GUARD, and it is repair-only.
    //
    // Rung 2 is biased by the decoded cell, so when the CELL is the wrong side of the
    // disagreement, a same-named place near that cell passes both halves of the accept rule and
    // arrives looking confirmed. Measured: "Le Panier" in the Côte d'Azur list is correctly pinned
    // in Marseille, its link decodes 159 km away, and a real "Le Panier" sits near the decode — so
    // the match is genuine and the pin it would overwrite is the right one.
    //
    // What breaks the tie is the company an entry keeps. A repair may only move a pin TOWARDS the
    // rest of its list: if the confirmed match is further from the list's own centre than the pin
    // already there, the pin was not the wrong side and nothing is written. This is exactly the
    // referee that told 51 bad pins apart from 4 bad links in the first place, and it is available
    // here precisely because a repair — unlike an import — always has the siblings to compare with.
    const siblings = storedForList(suspect.entry.sourceList ?? "")
      .map((s) => s.entry)
      .filter((e) => e.name !== suspect.entry.name);
    const centre = listCentroid(siblings);
    const candidate = outcome.entries[0]!;
    const movesTowardsTheList =
      !centre ||
      candidate.lat === undefined ||
      metresBetween({ lat: candidate.lat, lon: candidate.lon! }, centre) <=
        metresBetween({ lat: suspect.entry.lat!, lon: suspect.entry.lon! }, centre);

    // ONLY a confirmed match may overwrite a stored pin.
    //
    // The audit finds a DISAGREEMENT between a pin and its link; it does not know which side is
    // wrong, and usually it is the pin. But not always: measured on the store, 4 of 59 flagged
    // entries have a perfectly good pin and a feature id whose cell is in the wrong country
    // (Folie Alpine's "La Bottega MartaVini" is correctly in Chamonix and its link decodes to the
    // South Atlantic). Falling back to rung 3 for those would replace a correct pin with a wrong
    // one — turning an audit into a corruption. So when rung 2 confirms nothing, the entry is left
    // exactly as it was and reported for a human to settle.
    const isExact = outcome.resolved === 1 && movesTowardsTheList;
    if (isExact) exact++;
    else kept++;
    rows.push({
      name: suspect.entry.name,
      ...(suspect.entry.sourceList ? { sourceList: suspect.entry.sourceList } : {}),
      wrongBy: Math.round(suspect.metres),
      outcome: isExact ? "exact" : "kept",
      ...(outcome.resolved === 1 && !movesTowardsTheList
        ? { reason: "treffet ligger lenger fra resten av lista enn pinnen som alt står der" }
        : outcome.approximate[0]
          ? { reason: outcome.approximate[0].reason }
          : {}),
    });

    if (!dryRun && isExact) {
      // Written at the file name the store already gave it: nothing here changes a name, a list
      // membership or an identity, so nothing here may move a file (the setListCountry rule).
      const repaired = outcome.entries[0]!;
      writeRawEntry(suspect.file, serializeEntry({ ...repaired, updatedAt: new Date().toISOString() }));
    }
  }

  console.log(
    `[taste] pin audit${dryRun ? " (dry run)" : ""}: ${suspects.length} contradicted, ` +
      `${exact} re-matched exactly, ${kept} left untouched, ${searches} searches`,
  );

  if (!dryRun) revalidatePath("/taste");
  return { found: suspects.length, exact, kept, searches, rows };
}

export interface PlaceNameBackfill {
  /** Entries that gained a city and/or country. */
  named: number;
  /** Entries already carrying both — reported so "already done" is distinguishable from "did
   *  nothing and did not say why", the same reason `alreadySet` exists on setListCountry. */
  alreadyNamed: number;
  /** Entries with no pin, so nothing to derive from. */
  noPin: number;
}

/**
 * Names every stored place that has a pin but no city or country (ORB-116).
 *
 * The store holds 900-odd places imported before the field was derived at all, and re-exporting 26
 * CSVs from Google to attach two words each is not a reasonable ask. Offline, so it costs nothing
 * and can be re-run freely.
 *
 * No stamp is touched, for the same reason `setListCountry` touches none: deriving where a place
 * already was is bookkeeping about the entry, not a change to the place, and badging 900 entries
 * "endret" for it would drown the signal the badge exists for.
 */
export async function deriveMissingPlaceNames(): Promise<PlaceNameBackfill> {
  await requireUser();
  let named = 0;
  let alreadyNamed = 0;
  let noPin = 0;

  for (const stored of listDomain("places")) {
    const entry = stored.entry;
    if (!entry || entry.type !== "place") continue;
    if (entry.city !== undefined && entry.country !== undefined) {
      alreadyNamed++;
      continue;
    }
    const derived = derivePlaceName(entry);
    if (!derived) {
      noPin++;
      continue;
    }
    writeRawEntry(
      stored.file,
      serializeEntry({
        ...entry,
        ...(entry.city === undefined ? { city: derived.city } : {}),
        ...(entry.country === undefined ? { country: derived.country } : {}),
      }),
    );
    named++;
  }

  console.log(`[taste] place names derived: ${named} named, ${alreadyNamed} already, ${noPin} without a pin`);
  revalidatePath("/taste");
  return { named, alreadyNamed, noPin };
}
