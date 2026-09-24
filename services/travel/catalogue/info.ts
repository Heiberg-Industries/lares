/**
 * agent/tools/info.ts — the house-info card, ported from old Marcel's `infoCard`/`/info`
 * handling (`services/marcel/bin/marcel.ts:44-50` (`infoCard`), `516-525` (admin-DM slug
 * variant), `571-575` (group's own linked-trip variant, which also pins)). One tool,
 * `info(slug?)`, with two behaviors branching on the caller's chat type:
 *
 *  - group: ignores `slug` entirely and resolves the chat's OWN linked trip
 *    (`TripStore.tripForChat`) — a group always has exactly one trip, never several to pick
 *    from. Sends the card to the group and PINS it, matching old Marcel's group `/info`
 *    exactly. NOT admin-gated — old Marcel's group `/info` ran for any group member
 *    (`handleGroupMessage`'s own `/^\/info\b/i` branch has no sender check), because the group
 *    itself is already implicitly trusted (family members).
 *  - admin DM: `slug` is REQUIRED — there is no "current trip" concept outside a linked group,
 *    since the admin may be running several trips (planning next year's while this year's is
 *    still live). Sent to the admin DM only, never pinned (old Marcel's admin variant doesn't
 *    pin either). Admin-gated like every other admin-DM tool in this file set.
 *
 * Pinning uses the raw `callTelegramApi("pinChatMessage", ...)` primitive directly — a tool's
 * `ctx` carries no `telegram` handle (only channel event handlers get one; see eve's own
 * `ToolContext` type, which is `SessionContext` plus auth/abort/callId, nothing channel-shaped).
 * Best-effort: a pin failure must never sink the info card itself, mirroring old Marcel's own
 * `tg.pin` (`services/marcel/lib/telegram.ts:167-169`, silently caught).
 */
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";
import { sendTelegramMessage, callTelegramApi, splitTelegramMessageText } from "eve/channels/telegram";

import { isAllowedAdmin } from "../lib/principals.js";
import { TripStore, type Trip } from "../lib/trip-store.js";
import { telegramCredentials } from "../agent/channels/telegram.js";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { infoCard } from "../lib/info-card.js";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

function callerAuth(auth: SessionAuth | undefined) {
  return auth?.current ?? auth?.initiator ?? null;
}

const TRIP_MD = "trip.md";

// `infoCard` now lives in lib/info-card.ts (Fix Wave B, Finding 2) — re-exported here so this
// tool's own tests, and anything else already importing it from this module, keep working
// unchanged.
export { infoCard } from "../lib/info-card.js";

export interface InfoDeps {
  store(): TripStore;
  send(chatId: string, text: string): Promise<{ id: string }>;
  pin(chatId: string, messageId: string): Promise<void>;
}

/** A trip.md house-info card grows with the trip (wifi, house rules, notes accumulated over a
 *  stay) and has no length cap — past Telegram's 4096-char `sendMessage` limit (review fix,
 *  minor item 4), a raw send throws and the card never arrives at all. `splitTelegramMessageText`
 *  is eve's own chunker (newline/word-boundary aware); each chunk is sent as its own message, in
 *  order. Returns the FIRST chunk's id — that's the message the group/admin actually wants
 *  pinned (it carries the "🏠 Husets info" header), not whichever chunk happened to be sent
 *  last. */
async function realSend(chatId: string, text: string): Promise<{ id: string }> {
  let firstId: string | undefined;
  for (const chunk of splitTelegramMessageText(text)) {
    const result = await sendTelegramMessage({
      credentials: telegramCredentials,
      chatId,
      body: { text: chunk },
      fetch: telegramFetch,
    });
    if (firstId === undefined) firstId = result.id;
  }
  return { id: firstId ?? "" };
}

/** Best-effort, silently caught — matches old Marcel's own `tg.pin`. */
async function realPin(chatId: string, messageId: string): Promise<void> {
  await callTelegramApi({
    method: "pinChatMessage",
    body: { chat_id: chatId, message_id: Number(messageId), disable_notification: true },
    botToken: telegramCredentials.botToken,
    fetch: telegramFetch,
  }).catch(() => {});
}

export const defaultInfoDeps: InfoDeps = {
  store: () => new TripStore(dataRoot()),
  send: realSend,
  pin: realPin,
};

const inputSchema = z.object({
  slug: z
    .string()
    .optional()
    .describe(
      "trip slug — REQUIRED in an admin DM (there can be several trips); ignored in a group, " +
        "which always uses its own linked trip",
    ),
});

export function createInfoTool(deps: InfoDeps) {
  return defineTool({
    description:
      "Show the house/apartment info card (wifi, door code, address, emergency numbers) for a " +
      "trip. In a group chat this is always the group's own linked trip and gets pinned; in an " +
      "admin DM a trip slug is required — there is no single 'current' trip outside a group.",
    inputSchema,
    async execute({ slug }, ctx) {
      const caller = callerAuth(ctx.session.auth);
      const chatType = caller?.attributes?.["chat_type"];
      const chatId = caller?.attributes?.["chat_id"];
      const userId = caller?.attributes?.["user_id"];
      if (typeof chatId !== "string") return { error: "no chat context" };

      const store = deps.store();
      let trip: Trip | undefined;

      if (chatType === "group" || chatType === "supergroup") {
        trip = await store.tripForChat(chatId);
        if (!trip) return { error: "no trip linked to this chat" };

        const card = infoCard(store.read(trip, TRIP_MD));
        const sent = await deps.send(chatId, card);
        await deps.pin(chatId, sent.id);
        return { ok: true };
      }

      if (chatType !== "private" || typeof userId !== "string" || !isAllowedAdmin(userId)) {
        throw new Error("info: admin-DM only outside a linked group");
      }
      if (!slug) return { error: "slug is required in an admin DM" };

      trip = store.trips().find((t) => t.slug === slug);
      if (!trip) return { error: `fant ingen tur med slug "${slug}"` };

      await deps.send(chatId, infoCard(store.read(trip, TRIP_MD)));
      return { ok: true };
    },
  });
}

export default createInfoTool(defaultInfoDeps);
