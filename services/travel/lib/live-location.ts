/**
 * lib/live-location.ts — ephemeral, in-memory-only tracking of each Telegram chat's most
 * recently shared location (Task 11). Deliberately NOT persisted anywhere (no Postgres row,
 * no file) — matching Telegram's own semantics for a live-location share: it is a transient
 * signal, not a durable fact, and old Marcel had no equivalent to port from. A process restart
 * clearing every chat's tracked location back to "none" is an acceptable, even correct,
 * default.
 *
 * Two ways a location stops being valid:
 *   1. An EXPLICIT clear (`clearLiveLocation`) — the caller (`agent/channels/telegram.ts`'s
 *      `onMessage`) calls this when it recognizes a Telegram "stop sharing" update.
 *   2. TTL EXPIRY, off Telegram's own `live_period` field (seconds the share is valid for,
 *      carried on the SAME `location` object that starts the share) — `getLiveLocation` never
 *      returns a location past its `expiresAt`, even if nothing ever explicitly cleared it.
 *
 * (2) is the load-bearing mechanism in production, not (1). See
 * `agent/channels/telegram.ts`'s own top-of-file doc comment on the eve 0.32.0
 * `parseTelegramUpdate` gap: Telegram delivers both the periodic live-location ping updates
 * AND its own explicit "stop sharing" signal as `edited_message` updates, and eve's webhook
 * route silently drops any update that isn't `message` or `callback_query` before `onMessage`
 * is ever called. `clearLiveLocation` is real, tested code — useful the moment eve gains
 * `edited_message` support, and already reachable if a caller invokes it directly — but it is
 * NOT reachable from real Telegram traffic today. Without the TTL fallback, a live share would
 * stay "current" forever once eve drops the update that was supposed to end it.
 *
 * A one-off, non-live location share (a plain "send my location", no `live_period` at all)
 * gets a fixed fallback TTL (`ONE_OFF_LOCATION_TTL_SEC`) instead — still bounded, never
 * permanent.
 */

export interface LiveLocation {
  readonly lat: number;
  readonly lon: number;
}

interface StoredLocation extends LiveLocation {
  readonly expiresAt: number; // unix seconds
}

const store = new Map<string, StoredLocation>();

/** One hour — a plain (non-live) location share carries no Telegram-given expiry of its own;
 *  this caps how long eve-marcel treats it as current rather than holding it forever. */
export const ONE_OFF_LOCATION_TTL_SEC = 3600;

function nowSec(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

/** Records `chatId`'s most recent location, valid for `ttlSec` seconds from `nowMs` (defaults
 *  to wall-clock time — tests pass a fixed value to control expiry deterministically). */
export function setLiveLocation(chatId: string, lat: number, lon: number, ttlSec: number, nowMs = Date.now()): void {
  store.set(chatId, { lat, lon, expiresAt: nowSec(nowMs) + ttlSec });
}

/** Explicit clear — called when the caller recognizes a "stop sharing" update. See this
 *  file's top-of-file doc comment for why TTL expiry, not this function, is what actually
 *  keeps production traffic from serving a stale location today. */
export function clearLiveLocation(chatId: string): void {
  store.delete(chatId);
}

/** Returns `chatId`'s tracked location, or `null` if none is on file or it has expired.
 *  Lazily evicts an expired entry on read — no background timer, matching this module's
 *  "no persistence, no extra machinery" scope. */
export function getLiveLocation(chatId: string, nowMs = Date.now()): LiveLocation | null {
  const entry = store.get(chatId);
  if (!entry) return null;
  if (nowSec(nowMs) >= entry.expiresAt) {
    store.delete(chatId);
    return null;
  }
  return { lat: entry.lat, lon: entry.lon };
}

/** True iff `chatId` currently has a non-expired location on file. Used by
 *  `agent/channels/telegram.ts` to tell a genuine "stop" update (no `live_period`, but a live
 *  share WAS being tracked) apart from a fresh one-off share (no `live_period`, nothing
 *  tracked yet). */
export function hasLiveLocation(chatId: string, nowMs = Date.now()): boolean {
  return getLiveLocation(chatId, nowMs) !== null;
}

/** Test-only: wipes every tracked chat so test files don't leak state into each other via this
 *  module-scoped `Map`. */
export function __resetLiveLocationStoreForTest(): void {
  store.clear();
}
