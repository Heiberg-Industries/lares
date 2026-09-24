/**
 * agent/tools/predeparture_pack.ts — Tier 2 #4: NYC place-shortlisting pre-pack
 * (`docs/superpowers/plans/2026-08-16-eve-marcel-wave.md`'s own framing: "a one-shot
 * pre-departure brief — taste-boosted restaurant/venue shortlist near the hotel/itinerary
 * stops, sent as an immersive pack before wheels-up, rather than only on-demand mid-trip").
 * Admin-DM, trigger + assembly ONLY: every bit of search/ranking logic is `nearby_places`
 * (Task 6) verbatim — this file calls that tool's own `execute`, once per stop, and never
 * re-implements discovery, taste cross-referencing, or ranking.
 *
 * "Known stops" are an explicit tool input rather than something this tool derives from
 * itinerary.md itself: the conversational model already has (or can read, via another tool)
 * the trip's itinerary and is in the best position to decide what counts as a "stop" for a
 * given trip — keeping this tool a pure trigger+assembly step.
 *
 * Photo sending (Fix Wave B, Finding 3 — a review fix on this file's own earlier premise): the
 * original version of this file claimed eve has no send-side photo primitive at all. That
 * wasn't quite right — `lib/telegram-photo.ts`'s `sendTelegramPhoto` is a real multipart
 * upload (ported from old Marcel's own `sendPhoto`). The stop's TEXT message (bold header, each
 * place name rendered as a REAL clickable `<a href="mapsUrl">` link when `nearby_places`
 * returned one — never a fabricated link) is sent via `callTelegramApi` (a raw,
 * arbitrary-JSON-body Bot API call already used elsewhere in this file set —
 * `agent/tools/info.ts`'s `pinChatMessage`) with `parse_mode: "HTML"`, exactly as before. No
 * shared `toTelegramHtml`-style helper exists anywhere in this codebase (checked before
 * hand-rolling one) — `escapeHtml`/`escapeHtmlAttr` below are this file's own minimal,
 * Telegram-HTML-safe escaping.
 *
 * **Ordering and failure containment (review fix, Important #3):** the text is ALWAYS sent
 * FIRST, unconditionally — it is the guaranteed primary content. A real photo of the stop's
 * top hit (when it carries a Google Places `photoRef`) is sent AFTER, strictly as best-effort
 * garnish, inside its own try/catch that logs and moves on rather than propagating — mirroring
 * old Marcel's own explicit discipline (`bin/marcel.ts:230-233`: "the text ... must never be
 * hostage to garnish... [chat-bound actions] are individually best-effort for the same
 * reason"). An earlier version of this file sent the photo INSTEAD of the text and let a
 * `sendPhotoMessage` failure propagate uncaught — losing that stop's content entirely and
 * aborting every remaining stop in the `for` loop. Never again: a photo failure here can only
 * ever cost the photo, never the text, and never another stop.
 */
import { readFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { callTelegramApi, splitTelegramMessageText } from "eve/channels/telegram";

import { isAllowedAdmin } from "../lib/principals.js";
import { TripStore, type Trip } from "../lib/trip-store.js";
import { TasteStore } from "../lib/taste-store.js";
import { nearTrip } from "../lib/taste.js";
import type { PlaceEntry } from "@lares/taste";
import { telegramCredentials } from "../agent/channels/telegram.js";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { sendTelegramPhoto } from "../lib/telegram-photo.js";
import { makeGooglePlaces } from "../lib/google-places.js";
import type { NearbyCategory } from "../lib/nearby.js";
import type { DiscoveryHit } from "../lib/discovery.js";
import nearbyPlacesTool from "./nearby_places.js";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

/** Reads an OPTIONAL secret, lazily — matches `nearby_places.ts`'s identical helper (duplicated
 *  per this codebase's own per-tool-file self-containment convention). */
function optionalSecret(envVar: string, fallbackPath: string): string | undefined {
  const path = process.env[envVar] ?? fallbackPath;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function callerAuth(auth: SessionAuth | undefined) {
  return auth?.current ?? auth?.initiator ?? null;
}

function assertAdminDm(auth: SessionAuth | undefined): void {
  const caller = callerAuth(auth);
  const chatType = caller?.attributes?.["chat_type"];
  const userId = caller?.attributes?.["user_id"];
  if (chatType !== "private" || typeof userId !== "string" || !isAllowedAdmin(userId)) {
    throw new Error("predeparture_pack: admin-DM only");
  }
}

const MAX_HITS_PER_STOP = 5;
/** The saved-places opener is a reminder, not a catalogue — the full list lives in the
 *  console, and the per-turn trip context carries a longer slice of it. */
const MAX_SAVED_PLACES = 15;

/** Telegram's HTML `parse_mode` only requires escaping these three in text content —
 *  https://core.telegram.org/bots/api#html-style. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Same three, plus `"`, for text landing inside a double-quoted `href="..."` attribute —
 *  `mapsUrl` values can legitimately contain `&` (query strings). */
function escapeHtmlAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/** Pure — one stop's shortlist rendered as Telegram HTML, exported for its own unit test.
 *  `hits` arrives already taste/rating-sorted (⭐ Bendiks-liste first — `nearby_places` →
 *  `lib/discovery.ts`'s own sort), so this only formats, never re-ranks. */
export function composeStopMessage(stopName: string, hits: readonly DiscoveryHit[]): string {
  const lines = [`<b>🧭 ${escapeHtml(stopName)}</b>`];
  if (hits.length === 0) {
    lines.push("", "Fant ingen steder å foreslå her ennå.");
    return lines.join("\n");
  }
  for (const h of hits.slice(0, MAX_HITS_PER_STOP)) {
    const star = h.paaBendiksListe ? "⭐ " : "";
    const count = h.userRatingCount ? `, ${h.userRatingCount} vurderinger` : "";
    const rating = h.rating !== undefined ? ` (${h.rating.toFixed(1)}★${count})` : "";
    const name = escapeHtml(h.name);
    const label = h.mapsUrl ? `<a href="${escapeHtmlAttr(h.mapsUrl)}">${name}</a>` : name;
    lines.push(`${star}${label}${rating}`);
  }
  return lines.join("\n");
}

/** ORB-100 cross-feature: the pack opens with what Bendik ALREADY saved near this destination,
 *  before any discovery result. Labelled as his own saved data, per the parent's truthfulness
 *  rule — the pack states what he saved and where from, and nothing about whether it is open or
 *  what it costs, which are tool questions at the time they are asked. Returns "" when there is
 *  nothing saved nearby, and the section is then not sent at all. */
export function composeSavedPlacesMessage(destinationName: string, places: readonly PlaceEntry[]): string {
  if (places.length === 0) return "";
  const lines = [`<b>📌 Dine lagrede steder — ${escapeHtml(destinationName)}</b>`, ""];
  for (const p of places.slice(0, MAX_SAVED_PLACES)) {
    const from = p.sourceList ? ` <i>(${escapeHtml(p.sourceList)})</i>` : "";
    const note = p.note ? ` — ${escapeHtml(p.note.replace(/\s+/g, " ").trim())}` : "";
    lines.push(`${escapeHtml(p.name)}${from}${note}`);
  }
  if (places.length > MAX_SAVED_PLACES) {
    lines.push("", `… og ${places.length - MAX_SAVED_PLACES} til i listene dine.`);
  }
  return lines.join("\n");
}

export interface PredeparturePackDeps {
  store(): TripStore;
  /** ORB-100: Bendik's saved places near this trip. Injected so tests need no /srv/taste mount,
   *  and so an unmounted store is simply an empty list rather than a failure. */
  savedNearby?(trip: Trip): PlaceEntry[];
  /** Calls `nearby_places` (Task 6) verbatim — the default wires this straight to that tool's
   *  own `execute`, sharing this tool's own `ctx` (same session, just a proxied in-process
   *  call, never a separate turn). */
  searchStop(
    input: { category: NearbyCategory; query?: string; lat: number; lon: number },
    ctx: ToolContext,
  ): Promise<{ hits: DiscoveryHit[]; kilde: "Google" | "OpenStreetMap" }>;
  /** Sends the stop's text shortlist — ALWAYS called, first, for every stop, regardless of
   *  whether a photo is also sent afterward (review fix, Important #3: text is the guaranteed
   *  primary content, never held hostage to a photo). */
  send(chatId: string, text: string): Promise<void>;
  /** Fix Wave B, Finding 3 — fetches photo bytes for a Google Places `photoRef` (mirrors old
   *  Marcel's `deps.placePhoto`, `services/marcel/bin/marcel.ts:111-113,1168`). OPTIONAL: when
   *  omitted (no Google Places key configured — `defaultPredeparturePackDeps` only wires it
   *  when `GOOGLE_PLACES_API_KEY_FILE`/the secret file resolves), every stop's photo attempt is
   *  skipped entirely — the text (`send`, above) still always goes out. */
  photo?(photoRef: string): Promise<Buffer | null>;
  /** Fix Wave B, Finding 3 — sends the stop's top hit as a real photo, AFTER the text
   *  (review fix, Important #3), with the SAME rendered HTML content `composeStopMessage`
   *  already produced for the text message, as its caption. Only called when `photo()` is
   *  provided AND actually resolves bytes for that stop's top hit; `execute()` wraps this call
   *  in its own try/catch so a rejection here costs only the photo, never the stop's text or
   *  the rest of the loop. `captionHtml`, not markdown: `composeStopMessage` already renders
   *  final Telegram HTML (bold header, real `<a href>` links) — re-running it through a
   *  markdown-to-HTML converter would double-escape those already-real tags. */
  sendPhotoMessage?(chatId: string, photo: Buffer, captionHtml: string): Promise<void>;
}

export const defaultPredeparturePackDeps: PredeparturePackDeps = {
  store: () => new TripStore(dataRoot()),
  // Reads the read-only fleet store; an absent mount yields [] and the section is skipped.
  savedNearby: (trip) => nearTrip(new TasteStore().places(), trip.destination),
  // `nearby_places`' own `execute` return type is widened by `defineTool`'s generic overload
  // resolution to include the (here, impossible) AsyncIterable/sync-value cases a streaming
  // tool could return — cast to the concrete shape its actual implementation always resolves.
  searchStop: async (input, ctx) =>
    (await nearbyPlacesTool.execute({ radiusM: 1500, ...input }, ctx)) as {
      hits: DiscoveryHit[];
      kilde: "Google" | "OpenStreetMap";
    },
  // `sendTelegramMessage`'s own typed `TelegramMessageBody` has no `parse_mode` field — routed
  // through the raw `callTelegramApi` (arbitrary JSON body) instead, same primitive
  // `agent/tools/info.ts` already uses for `pinChatMessage`.
  //
  // Split past Telegram's 4096-char limit (review fix, minor item 4) — MAX_HITS_PER_STOP caps
  // this at 5 short lines normally, but an unusually long venue name/rating string could still
  // push a stop's message over the cap, and a raw send would throw mid-loop, leaving later
  // stops unsent. `splitTelegramMessageText` is plain-text/newline-aware, not HTML-aware, but
  // `composeStopMessage`'s output is one complete `<a href="...">...</a>` (or plain-text) unit
  // PER LINE — its splitter prefers the last `\n` before the cutoff, so in practice a split
  // lands between complete lines, never mid-tag, unless a single line alone exceeds 4096 chars.
  send: async (chatId, text) => {
    for (const chunk of splitTelegramMessageText(text)) {
      await callTelegramApi({
        method: "sendMessage",
        body: { chat_id: chatId, text: chunk, parse_mode: "HTML" },
        botToken: telegramCredentials.botToken,
        fetch: telegramFetch,
      });
    }
  },
  // Read lazily, per call — never at module scope (eve-build-has-no-secrets: a build has no
  // secret files present at all, matching `nearby_places.ts`'s own `realDiscovery()`
  // reasoning). No Google Places key configured means `photo` resolves `null` for every
  // photoRef, and `execute()`'s own guard (`if (bytes)`) falls every stop through to the
  // text-only path — same end state as the key being absent, just decided per call instead of
  // once at import time.
  photo: (photoRef: string) => {
    const apiKey = optionalSecret("GOOGLE_PLACES_API_KEY_FILE", "/run/secrets/google-places-api-key");
    if (!apiKey) return Promise.resolve(null);
    return makeGooglePlaces({ apiKey, fetch: telegramFetch }).photo(photoRef);
  },
  sendPhotoMessage: async (chatId, photo, captionHtml) => {
    await sendTelegramPhoto({
      chatId,
      photo,
      captionHtml,
      botToken: telegramCredentials.botToken,
      fetch: telegramFetch,
    });
  },
};

const CATEGORY = z.enum([
  "restaurant",
  "cafe",
  "bakery",
  "grocery",
  "bar",
  "ice_cream",
  "pharmacy",
  "beach",
  "fuel",
  "atm",
  "playground",
]);

const inputSchema = z.object({
  tripSlug: z.string().min(1),
  stops: z
    .array(z.object({ name: z.string().min(1), lat: z.number(), lon: z.number() }))
    .min(1)
    .describe("the trip's known stops (hotel, neighborhoods, ...) — ONE shortlist message is sent per stop"),
  category: CATEGORY.default("restaurant"),
  query: z.string().optional().describe("free-text search bias, e.g. 'family-friendly dinner' — omit for a plain category search"),
});

export function createPredeparturePackTool(deps: PredeparturePackDeps) {
  return defineTool({
    description:
      "Send a pre-departure place shortlist to the trip's group — a taste-boosted round of " +
      "REAL, rated places near each of the trip's known stops, sent before wheels-up rather " +
      "than only on-demand mid-trip. Sends one shortlist message per stop (never one per " +
      "venue), plus a best-effort real photo of the top pick when Google has one — a photo " +
      "failure never costs the text. Admin-DM only; the trip must already be linked to a group.",
    inputSchema,
    async execute({ tripSlug, stops, category, query }, ctx) {
      assertAdminDm(ctx.session.auth);

      const store = deps.store();
      const trip = store.trips().find((t) => t.slug === tripSlug);
      if (!trip) return { error: `fant ingen tur med slug "${tripSlug}"` };
      if (!trip.chatId) return { error: "turen er ikke lenket til noen gruppe ennå" };

      // ORB-100: open with what Bendik already saved near this destination, before any
      // discovery result — best-effort, exactly like the photo garnish below. A taste-store
      // failure must never cost the pack itself.
      try {
        const saved = deps.savedNearby?.(trip) ?? [];
        const savedMessage = composeSavedPlacesMessage(trip.destination.name, saved);
        if (savedMessage !== "") await deps.send(trip.chatId, savedMessage);
      } catch (err) {
        console.error("eve-marcel: predeparture_pack saved-places section failed — continuing without it —", err);
      }

      let sent = 0;
      for (const stop of stops) {
        const result = await deps.searchStop({ category, query, lat: stop.lat, lon: stop.lon }, ctx);
        const message = composeStopMessage(stop.name, result.hits);

        // Text FIRST, always, unconditionally — the guaranteed primary content (review fix,
        // Important #3; see this file's own top-of-file doc comment).
        await deps.send(trip.chatId, message);

        // Photo SECOND, strictly best-effort garnish: never blocks the text above, and a
        // failure here (fetch or send) costs only the photo — caught locally so it can never
        // propagate out of this stop's iteration and abort the rest of the `stops` loop.
        const photoRef = result.hits[0]?.photoRef;
        if (photoRef && deps.photo && deps.sendPhotoMessage) {
          try {
            const bytes = await deps.photo(photoRef);
            if (bytes) {
              await deps.sendPhotoMessage(trip.chatId, bytes, message);
            }
          } catch (err) {
            console.error(
              `eve-marcel: predeparture_pack photo send failed for stop "${stop.name}" — continuing without it —`,
              err,
            );
          }
        }

        sent++;
      }

      return { ok: true, sent };
    },
  });
}

export default createPredeparturePackTool(defaultPredeparturePackDeps);
