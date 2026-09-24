/**
 * lib/extraction-cache.ts — persistent per-message extraction results for the Reise sweep
 * (2026-08-17, "The Big Apple" incident — designed in the QA session, built same day).
 *
 * WHY THIS EXISTS, in incident terms: the sweep ran ~100 billed LLM extractions, correctly
 * extracted Bendik's New York bookings — and then DISCARDED every one as "traff ingen
 * turdatoer" because no trip window matched (the trips-first model, ported faithfully from
 * old Marcel). A re-sweep re-billed all ~100 extractions and discarded them again. The
 * booking data was paid for twice and kept zero times.
 *
 * The cache turns that on its head:
 *   - every extraction result (booking or not-a-booking) is persisted per gmail message id,
 *     so a re-sweep never re-bills a message it has already understood;
 *   - a cached "no-trip" booking is REPLAYED against the current trip windows on every
 *     sweep — so creating the missing trip and re-sweeping files it for free;
 *   - `/nytur` goes one further and retro-files matching orphans the moment the trip is
 *     created (see `BookingPipeline.retroMatch`), no re-sweep needed;
 *   - the orphans themselves become the signal for trip DISCOVERY (`orphanClusters` in
 *     lib/bookings.ts): bookings clustering in a dateless-trip window ARE the new trip.
 *
 * "unclear" outcomes are deliberately NOT cached: they are transient (model hiccup,
 * unparseable reply) and should be retried by the next sweep.
 *
 * File-first like everything else in Marcel's store: one JSON map at
 * `<dataRoot>/extractions.json`, written atomically (tmp + rename) so a crash mid-write
 * cannot corrupt the cache. No DB, no migration, and it rides the existing
 * /srv/eve-marcel volume.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { Booking, CacheableOutcome } from "./bookings.js";

export interface CachedExtraction {
  /** Last known pipeline outcome for this message. "no-trip" entries carry the booking and
   *  are the retro-match/discovery inventory; "not-booking" entries exist purely to skip
   *  the LLM on re-sweeps. */
  /** ORB-105 adds "cancelled": the mail was understood and its effect was to REMOVE or suppress
   *  a reservation. Cached like any other understood mail, which is precisely what makes the
   *  cancellation-before-booking ordering work — the pipeline consults these entries to refuse
   *  filing something a cancellation has already retired. */
  outcome: CacheableOutcome;
  booking: Booking | null;
  subject: string;
  extractedAt: string; // ISO 8601
  /** Which extractor produced this verdict (see EXTRACTOR_VERSION). Absent on every entry
   *  written before versioning existed, which is treated as version 1. */
  extractorVersion?: number;
}

/**
 * The extraction prompt/schema generation. BUMP IT whenever a change to `makeExtractBooking`
 * could turn one verdict into a different one.
 *
 * Why this exists (2026-08-17, found while verifying ORB-105 against the live store): the
 * cancellation-aware extractor shipped, a full sweep ran, and the mail
 * "Your Stay at The Standard, High Line Has Been Cancelled" was still skipped. It had been
 * cached as `not-booking` at 11:45Z by the OLD prompt — the exact blind spot ORB-105 was
 * written to close — and `processMailInner` treats a cached non-booking as terminal. The fix
 * shipped and could never take effect on the one mail that motivated it.
 *
 * That is the whole failure class: **a cache keyed only by message id silently outlives the
 * code whose answer it stores.** The version is the missing half of the key.
 *
 * 2 — ORB-105: `action: "book" | "cancel"`, and the prompt now states that a cancellation IS a
 *     booking mail.
 */
export const EXTRACTOR_VERSION = 2;

/**
 * Is a cached entry still trustworthy?
 *
 * Deliberately NOT "any stale entry is a miss". A stale entry that carries a BOOKING holds
 * extracted data the pipeline replays against current state on every sweep anyway; re-running
 * ~90 billed Opus extractions to re-derive the same fields would cost a full sweep's budget for
 * nothing. A stale `not-booking` holds no data at all — it is a bare verdict, and the verdict is
 * precisely what a prompt change alters. So those, and only those, are re-extracted.
 *
 * If a future bump changes how bookings THEMSELVES are extracted, widen this — and say in the
 * version note above that it costs one full re-sweep.
 */
export function isStaleVerdict(entry: CachedExtraction): boolean {
  return entry.booking === null && (entry.extractorVersion ?? 1) < EXTRACTOR_VERSION;
}

export interface ExtractionCache {
  get(id: string): CachedExtraction | undefined;
  put(id: string, entry: CachedExtraction): void;
  entries(): Array<[string, CachedExtraction]>;
}

const CACHE_FILE = "extractions.json";

/** File-backed cache. Loaded lazily on first access; every put writes through atomically.
 *  A corrupt/missing file degrades to an empty cache (the sweep then just re-extracts —
 *  the pre-cache behavior, never a crash). */
export function fileExtractionCache(rootDir: string): ExtractionCache {
  const file = path.join(rootDir, CACHE_FILE);
  let map: Record<string, CachedExtraction> | undefined;

  function load(): Record<string, CachedExtraction> {
    if (map !== undefined) return map;
    try {
      map = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, CachedExtraction>;
    } catch {
      map = {};
    }
    return map;
  }

  function save(): void {
    const tmp = `${file}.tmp`;
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 1));
    fs.renameSync(tmp, file);
  }

  return {
    get(id) {
      return load()[id];
    },
    put(id, entry) {
      load()[id] = entry;
      save();
    },
    entries() {
      return Object.entries(load());
    },
  };
}
