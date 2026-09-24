/**
 * lib/sweep-marker.ts — the in-progress marker for /sveip's detached sweep (ORB-104).
 *
 * WHY THIS EXISTS, in incident terms (2026-08-17): the sweep is a deliberately detached
 * fire-and-forget promise (`agent/tools/sveip.ts`'s `void deps.backfill()`), so a container
 * restart kills it mid-flight with no rejection, no log line and no DM. It happened twice in
 * one afternoon — two deploys landed on top of a running sweep — and both times the only
 * evidence was silence. Silence is also what a sweep that is still working looks like, and
 * what a sweep that hung looks like. Three very different states, one indistinguishable
 * symptom; the afternoon was spent telling them apart from proxy logs after the fact.
 *
 * The marker collapses that ambiguity to a file:
 *   - written when the sweep detaches, cleared when it reports (success OR failure);
 *   - a marker still present at STARTUP means the last sweep died with the process — the
 *     admin gets told, once, and the marker is cleared;
 *   - a FRESH marker means a sweep is genuinely running, so a second /sveip says so instead
 *     of starting a duplicate hundred-mail run.
 *
 * A stale-but-not-restarted marker (older than the window, same process) is the "hung"
 * case — it stops blocking new sweeps rather than wedging /sveip forever, because a hung
 * sweep must never make the tool permanently unusable.
 *
 * File-first like the rest of Marcel's store (`lib/extraction-cache.ts`'s own reasoning):
 * one small JSON at `<dataRoot>/sweep-in-progress.json`, written atomically (tmp + rename)
 * so a crash mid-write cannot leave an unparseable marker. No DB, no migration.
 *
 * NOTHING here throws. A marker that cannot be read or written must never take down a sweep
 * — the marker is diagnostics, and diagnostics that break the thing they observe are worse
 * than no diagnostics.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const MARKER_FILE = "sweep-in-progress.json";

/** How long a marker counts as "a sweep is genuinely running". A full sweep is ~100
 *  sequential LLM extractions over ~130 Gmail reads; the two real ones observed took well
 *  under a minute each of Gmail time but minutes of extraction. 15 minutes is comfortably
 *  past a healthy sweep and comfortably short of blocking the admin for an afternoon. */
export const SWEEP_FRESH_MS = 15 * 60_000;

export interface SweepMarker {
  /** Epoch ms when the sweep detached. */
  startedAt: number;
}

function markerPath(dataRoot: string): string {
  return path.join(dataRoot, MARKER_FILE);
}

export function readSweepMarker(dataRoot: string): SweepMarker | null {
  try {
    const raw = fs.readFileSync(markerPath(dataRoot), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const startedAt = (parsed as { startedAt?: unknown })?.startedAt;
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
    return { startedAt };
  } catch {
    // Absent (the normal case) or corrupt (hand-edited, half-written on a full disk):
    // both mean "no usable marker", and neither is worth failing a sweep over.
    return null;
  }
}

export function writeSweepMarker(dataRoot: string, startedAt: number): void {
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    const tmp = `${markerPath(dataRoot)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ startedAt }));
    fs.renameSync(tmp, markerPath(dataRoot));
  } catch (err) {
    console.error("eve-marcel: could not write the sweep marker (sweep continues regardless) —", err);
  }
}

export function clearSweepMarker(dataRoot: string): void {
  try {
    fs.rmSync(markerPath(dataRoot), { force: true });
  } catch (err) {
    console.error("eve-marcel: could not clear the sweep marker —", err);
  }
}

/** True while a marker is recent enough that a sweep is presumed still running. */
export function isSweepRunning(marker: SweepMarker | null, nowMs: number): boolean {
  return marker !== null && nowMs - marker.startedAt < SWEEP_FRESH_MS;
}

/** The admin DM for a sweep that died with its process. Norwegian, and explicit that
 *  re-running costs nothing — the extraction cache already holds every message the dead
 *  sweep paid for (`lib/extraction-cache.ts`). */
export const INTERRUPTED_SWEEP_DM =
  "Forrige reise-sveip ble avbrutt av en omstart — kjør /sveip igjen (gratis, alt er cachet).";

export const SWEEP_ALREADY_RUNNING = "et sveip kjører allerede";

export interface StartupCheckDeps {
  dataRoot: string;
  now(): number;
  notify(text: string): Promise<void>;
}

/**
 * Startup half of the contract: a marker present when the process starts means the previous
 * sweep never reported. Tells the admin once, then clears — so the next start is quiet and a
 * restart loop cannot turn one dead sweep into a stream of DMs.
 *
 * Returns whether it notified, for the test and for the caller's own logging.
 */
export async function notifyIfSweepInterrupted(deps: StartupCheckDeps): Promise<boolean> {
  const marker = readSweepMarker(deps.dataRoot);
  if (marker === null) return false;

  // Clear FIRST: if the notify throws (Telegram down at boot, say), the marker must not
  // survive to fire again on every subsequent restart. One dead sweep, at most one DM.
  clearSweepMarker(deps.dataRoot);
  try {
    await deps.notify(INTERRUPTED_SWEEP_DM);
    return true;
  } catch (err) {
    console.error("eve-marcel: could not DM the interrupted-sweep notice —", err);
    return false;
  }
}
