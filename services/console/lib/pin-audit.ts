// services/console/lib/pin-audit.ts — does a stored pin agree with the place it claims to be?
//
// WHY THIS EXISTS. A saved place's URL carries a feature id whose first half decodes, offline, to
// roughly where Google thinks that feature is (`@lares/taste/s2`). That gives every pinned entry a
// SECOND, independent opinion about its own position — one nothing else in the pipeline can
// contaminate, because it is derived from the saved link itself rather than from any lookup.
//
// Turned on the store for the first time on 2026-08-17 it immediately found 51 of 928 pins sitting
// on the wrong continent: "The Bird" saved in a Berlin list pinned in San Francisco, "Pompette" in
// a Copenhagen list pinned in Brisbane, "Madre" in a Tbilisi list pinned in North Carolina. Every
// one is the signature of a name search that matched a same-named place somewhere else — which is
// exactly what a coordinate backfill does when it falls back from resolving a URL to searching a
// name.
//
// The check is deliberately blunt. It does not try to improve a pin that is merely imprecise: the
// feature's cell is stamped at creation and never moved afterwards, so a few kilometres of
// disagreement is normal and means nothing (79% of the store sits within 5 km, and that spread is
// the CELL drifting, not the pin being wrong). Only a disagreement far beyond any plausible drift
// is evidence, and `CONTRADICTION_M` is set where the evidence starts.
import { metresBetween, featureIdToLatLon } from "@lares/taste/s2";
import { isPlace, type PlaceEntry } from "@lares/taste";

import { listDomain, type StoredEntry } from "./taste-store";

/**
 * How far a stored pin may sit from its own feature's cell before it is called wrong.
 *
 * 50 km, from the store's own distribution: measured across 928 pinned entries, genuine cell drift
 * exceeds 50 km for about 1% of them, while every one of the 51 known-bad pins was more than 300
 * km out — most of them thousands. There is a wide empty band between "stale cell" and "wrong
 * city", and this sits in it. Erring high is the right direction: a false accusation would replace
 * a correct pin with a worse one.
 */
export const CONTRADICTION_M = 50_000;

export interface ContradictedPin {
  file: string;
  entry: PlaceEntry;
  /** Where the saved URL's own feature id says this place is. */
  decoded: { lat: number; lon: number };
  /** How far the stored pin is from that — the size of the disagreement. */
  metres: number;
}

/** The point an entry's own saved URL decodes to, when it carries a feature id at all. */
export function decodedPinFor(entry: PlaceEntry): { lat: number; lon: number } | undefined {
  return featureIdToLatLon(entry.url?.match(/!1s(0x[0-9a-f]+)/i)?.[1]);
}

/**
 * Every stored place whose pin its own saved link contradicts.
 *
 * Entries with no pin, no URL, or a URL carrying no feature id are silently skipped — there is
 * nothing to disagree about. An entry already flagged `approx` is skipped too: its pin IS the
 * decoded cell, so it can never contradict itself, and it is already labelled as unconfirmed.
 */
export function contradictedPins(entries: readonly StoredEntry[]): ContradictedPin[] {
  const out: ContradictedPin[] = [];
  for (const stored of entries) {
    const entry = stored.entry;
    if (!entry || !isPlace(entry)) continue;
    if (entry.lat === undefined || entry.lon === undefined || entry.approx) continue;
    const decoded = decodedPinFor(entry);
    if (!decoded) continue;
    const metres = metresBetween({ lat: entry.lat, lon: entry.lon }, decoded);
    if (metres > CONTRADICTION_M) out.push({ file: stored.file, entry, decoded, metres });
  }
  return out;
}

/** The same audit, over the whole places domain. */
export function auditStoredPins(): ContradictedPin[] {
  return contradictedPins(listDomain("places"));
}
