/**
 * lib/position.ts — the admin's last known position, file-first (ORB-101).
 *
 * `lib/live-location.ts` already tracks a chat's latest shared location IN MEMORY, which is the
 * right shape for answering "what is nearby?" inside a conversation: transient, per-chat, gone on
 * restart. Proximity pings need something different. A geofence tick runs every minute in a
 * SCHEDULE — a different execution context from the webhook that received the position — and must
 * survive the container restarts that a deploy causes mid-trip. So the position is written to one
 * small file under the trip data root, exactly like every other durable thing Marcel owns.
 *
 * PRIVACY (the parent's standing rule, and the reason this file is deliberately boring): the
 * position never leaves the box. It is written to Marcel's own bind mount, never into `/srv/taste`
 * (which the console reads and Bendik curates), never into the Brain, never into a trip file that
 * gets summarised into a prompt, and never sent to another agent. It is admin-only at the intake
 * boundary — a group member's location share is refused there, not filtered here — and it expires
 * on its own so a forgotten share cannot become a permanent tracker.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const POSITION_FILE = "position.json";

export interface Position {
  readonly lat: number;
  readonly lon: number;
  /** Unix seconds when this position was reported. */
  readonly at: number;
  /** Unix seconds after which it is stale — Telegram's own `live_period` from the share, or a
   *  bounded fallback for a one-off share. Never open-ended. */
  readonly expiresAt: number;
}

function positionPath(dataRoot: string): string {
  return path.join(dataRoot, POSITION_FILE);
}

/** Nothing here throws: a position that cannot be read or written must never break a turn or a
 *  schedule tick. The whole feature degrades to "no position", which is simply no pings. */
export function readPosition(dataRoot: string): Position | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(positionPath(dataRoot), "utf8"));
    const p = parsed as Partial<Position>;
    if (
      typeof p.lat !== "number" || typeof p.lon !== "number" ||
      typeof p.at !== "number" || typeof p.expiresAt !== "number" ||
      !Number.isFinite(p.lat) || !Number.isFinite(p.lon)
    ) {
      return null;
    }
    return { lat: p.lat, lon: p.lon, at: p.at, expiresAt: p.expiresAt };
  } catch {
    return null;
  }
}

export function writePosition(dataRoot: string, position: Position): void {
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    const tmp = `${positionPath(dataRoot)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(position));
    fs.renameSync(tmp, positionPath(dataRoot));
  } catch (err) {
    console.error("eve-marcel: could not write the position file —", err);
  }
}

/** Explicit stop — Telegram's own "stopped sharing" signal, and the admin's right to end it. */
export function clearPosition(dataRoot: string): void {
  try {
    fs.rmSync(positionPath(dataRoot), { force: true });
  } catch (err) {
    console.error("eve-marcel: could not clear the position file —", err);
  }
}

/** The position only if it is still current. A stale position must never produce a ping: telling
 *  Bendik he is near somewhere he left an hour ago is worse than saying nothing. */
export function currentPosition(dataRoot: string, nowSec: number): Position | null {
  const position = readPosition(dataRoot);
  if (position === null) return null;
  return position.expiresAt > nowSec ? position : null;
}
