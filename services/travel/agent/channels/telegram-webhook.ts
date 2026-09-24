/**
 * agent/channels/telegram-webhook.ts — the webhook front door (ORB-101).
 *
 * WHY THIS EXISTS. Telegram delivers live-location updates as `edited_message`, and eve 0.32.0's
 * `parseTelegramUpdate` drops every update that is not `message` or `callback_query`. Proximity
 * pings need those edits, so something has to see the raw body before eve's Telegram channel does.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not re-implement dispatch, sessions, HITL, attachments
 * or auth. It reads one thing — a location — and then forwards the untouched body to the real
 * Telegram channel, which now listens on an INNER path (`TELEGRAM_INNER_ROUTE`). The external
 * contract is unchanged: Telegram still POSTs to the same URL it always has, so there is no
 * `setWebhook` call, no window where updates go nowhere, and rollback is just the previous image.
 *
 * FAIL-OPEN, ALWAYS. Marcel going deaf is far worse than a missed ping. Location handling sits in
 * its own try/catch and the forward happens regardless — if anything here throws, the update still
 * reaches the channel exactly as before.
 *
 * SECURITY. Verification happens BEFORE the position is touched: an unverified POST could otherwise
 * move Bendik's recorded position, which is both a privacy leak and a way to fake proximity pings.
 * The secret token is the same one the channel checks, and the admin allowlist is applied here too
 * — a group member's location share is refused, not stored and filtered later.
 */
import { defineChannel, POST } from "eve/channels";

import { parseLocationUpdate } from "../../lib/location-update.js";
import { neutralizeBotReplyMarker } from "@lares/agent-kit/telegram-reply-fix";
import { clearPosition, writePosition } from "../../lib/position.js";
import { isAllowedAdmin } from "../../lib/principals.js";
import { TELEGRAM_INNER_ROUTE, TELEGRAM_PUBLIC_ROUTE } from "@lares/agent-kit/telegram-routes";
import { telegramCredentials } from "./telegram.js";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** A one-off pin drop carries no live period; bound it rather than trusting it forever. */
const ONE_OFF_TTL_SEC = 3600;

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

function innerUrl(): string {
  const port = process.env["PORT"] ?? "3000";
  return `http://127.0.0.1:${port}${TELEGRAM_INNER_ROUTE}`;
}

/** Constant-time-ish compare. The secret is short and the attacker cannot iterate a webhook, but
 *  there is no reason to leak length or prefix either. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export interface LocationIntakeDeps {
  root(): string;
  now(): number;
  write: typeof writePosition;
  clear: typeof clearPosition;
  isAdmin(userId: string): boolean;
}

export const defaultLocationIntakeDeps: LocationIntakeDeps = {
  root: dataRoot,
  now: () => Date.now(),
  write: writePosition,
  clear: clearPosition,
  isAdmin: isAllowedAdmin,
};

/**
 * Records (or clears) the admin's position from a raw update body. Returns what it did, for the
 * test and for logging — never for Telegram, which only ever gets "ok".
 */
export function handleLocationUpdate(body: unknown, deps: LocationIntakeDeps): "stored" | "cleared" | "ignored" {
  const update = parseLocationUpdate(body);
  if (update === null) return "ignored";

  // Admin only. A group member's share must not become "where Bendik is" — that would let anyone
  // in a trip group decide what "nearby" resolves to.
  if (update.userId === undefined || !deps.isAdmin(update.userId)) return "ignored";

  if (update.stopped) {
    deps.clear(deps.root());
    return "cleared";
  }

  const nowSec = Math.floor(deps.now() / 1000);
  deps.write(deps.root(), {
    lat: update.lat,
    lon: update.lon,
    at: nowSec,
    expiresAt: nowSec + (update.livePeriod ?? ONE_OFF_TTL_SEC),
  });
  return "stored";
}

export default defineChannel({
  routes: [
    POST(TELEGRAM_PUBLIC_ROUTE, async (request) => {
      // Read the body ONCE, as text, so the exact bytes Telegram sent are what gets forwarded —
      // re-serialising JSON would change nothing semantically but everything about being able to
      // say the channel saw what Telegram sent.
      const raw = await request.text();
      const secretToken = request.headers.get(SECRET_HEADER);

      try {
        const expected = await telegramCredentials.webhookSecretToken();
        if (secretMatches(secretToken, expected)) {
          const outcome = handleLocationUpdate(JSON.parse(raw), defaultLocationIntakeDeps);
          if (outcome !== "ignored") console.log(`[telegram-webhook] live location ${outcome}`);
        }
        // An unverified body is NOT rejected here — the inner channel is the authority on that, and
        // duplicating the rejection would mean two places deciding what counts as authentic.
      } catch (err) {
        // Deliberately swallowed: the forward below is what keeps Marcel working.
        console.error("[telegram-webhook] location intake failed — forwarding anyway —", err);
      }

      // ORB-111 — the ONE deviation from "forward the untouched body". eve routes any reply to a
      // bot message as an input response and then drops it when no freeform prompt is pending,
      // so a reply to Marcel vanishes into a turn that makes no model call. Clearing that one
      // flag puts the reply back on eve's ordinary message path. See lib/telegram-reply-fix.ts
      // for the upstream lines and the tripwire.
      const { body, rewritten } = neutralizeBotReplyMarker(raw);
      if (rewritten) console.log("[telegram-webhook] reply-to-bot forwarded as a message (ORB-111)");

      try {
        return await fetch(innerUrl(), {
          method: "POST",
          headers: {
            "content-type": request.headers.get("content-type") ?? "application/json",
            ...(secretToken === null ? {} : { [SECRET_HEADER]: secretToken }),
          },
          body,
        });
      } catch (err) {
        // Telegram retries on a non-2xx, which is what we want if the inner hop failed.
        console.error("[telegram-webhook] forward to the Telegram channel failed —", err);
        return new Response("forward failed", { status: 502 });
      }
    }),
  ],
});
