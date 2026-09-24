/**
 * lib/location-update.ts — pure reading of a Telegram update's location payload (ORB-101).
 *
 * THE GAP this exists to bridge: Telegram delivers a live-location share in three parts, and only
 * the first reaches eve. The initial share arrives as a `message` update (eve handles it). Every
 * subsequent position — one every few seconds, which is the entire point of a LIVE share — and the
 * explicit "stopped sharing" signal both arrive as `edited_message` updates, and eve 0.32.0's
 * `parseTelegramUpdate` reads only `message` and `callback_query` before dropping everything else
 * (verified in `node_modules/eve/dist/src/public/channels/telegram/inbound.js`).
 *
 * So without this, Marcel learns where Bendik was when he STARTED sharing and never again — a
 * position that goes stale within a minute of a walk beginning, which is worse than none for
 * proximity pings.
 *
 * Pure: parsing only. The caller owns verification, the admin check, and the write.
 */

export interface LocationUpdate {
  /** Telegram chat the share came from. */
  readonly chatId: string;
  /** Telegram user who shared — the caller gates on this being the admin. */
  readonly userId: string | undefined;
  readonly lat: number;
  readonly lon: number;
  /** Seconds the live share remains valid, absent for a one-off share AND for Telegram's own
   *  "stopped sharing" edit — which is why `stopped` below is derived, not read. */
  readonly livePeriod: number | undefined;
  /** True when this looks like the end of a live share rather than a new position: an
   *  `edited_message` carrying a location with no `live_period` left on it. */
  readonly stopped: boolean;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function idOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Reads a location out of a raw Telegram update body, from `message` OR `edited_message`.
 *
 * Returns null for every update that carries no location at all — which is the overwhelming
 * majority, and must be cheap and silent.
 */
export function parseLocationUpdate(body: unknown): LocationUpdate | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  for (const key of ["edited_message", "message"] as const) {
    const message = b[key];
    if (typeof message !== "object" || message === null) continue;
    const m = message as Record<string, unknown>;

    const location = m["location"];
    if (typeof location !== "object" || location === null) continue;
    const loc = location as Record<string, unknown>;

    const lat = num(loc["latitude"]);
    const lon = num(loc["longitude"]);
    if (lat === undefined || lon === undefined) continue;

    const chat = m["chat"] as Record<string, unknown> | undefined;
    const chatId = idOf(chat?.["id"]);
    if (chatId === undefined) continue;

    const livePeriod = num(loc["live_period"]);
    return {
      chatId,
      userId: idOf((m["from"] as Record<string, unknown> | undefined)?.["id"]),
      lat,
      lon,
      livePeriod,
      // An EDIT carrying a location that no longer advertises a live period is Telegram saying the
      // share ended. The same shape arriving as a fresh `message` is just a one-off pin drop.
      stopped: key === "edited_message" && livePeriod === undefined,
    };
  }
  return null;
}
