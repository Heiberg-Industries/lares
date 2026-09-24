/**
 * agent/hooks/log-marcel-reply.ts — logs Marcel's OWN reply into the linked trip's
 * conversation log, matching old Marcel's `logMarcelReply` call sites
 * (`services/marcel/bin/marcel.ts:557-655`, invoked right after every `tg.send(result.text)`).
 *
 * Fix Wave B review fix (Important #1): `lib/conversation-log.ts`'s own transcript renderer
 * has always branched on `e.marcel ? "Marcel" : e.name` (Task 8b), but nothing anywhere ever
 * appended an entry WITH `marcel: true` — `agent/channels/telegram.ts`'s `appendInbound` only
 * ever logs INBOUND messages. So Finding 1's own "## Samtalen nylig" section was one-sided:
 * every group member's messages, never Marcel's own replies — not a real conversation memory,
 * just an inbound feed. This hook is the missing other half.
 *
 * Uses eve's `message.completed` STREAM HOOK (`eve/hooks`, observe-only) rather than touching
 * the Telegram channel's own send path. Per eve's own docs (`docs/guides/hooks.md`,
 * "Execution order"): the channel adapter's default `message.completed` handler runs and
 * actually sends the reply FIRST, the event is durably recorded, and only THEN do hooks fire —
 * so this never risks or duplicates the real send, it only records what already went out.
 *
 * `message.completed` can fire more than once per turn — once per completed assistant text
 * block, including narration the model emits before a tool call (eve's own docs: "the agent
 * often emits interim assistant text before a tool call. To tell tool-call narration from a
 * terminal reply, check message.completed.data.finishReason"). Filtered to
 * `finishReason !== "tool-calls"` so only the turn's terminal reply is logged — matching old
 * Marcel's own `result.text`, the ONE final answer per `brain.answer()` call, never per-step
 * narration.
 *
 * Scope: only logs when the calling chat resolves to a linked trip (`TripStore.tripForChat`) —
 * the same resolution every conversational tool already uses. An admin-DM turn's chat id never
 * matches a trip's own `chatId` (that's always the GROUP's id), so this is a no-op for admin DM
 * today — admin DM has no conversation log of its own anywhere in this port (a separate,
 * pre-existing gap, not something this fix invents or expands).
 */
import { defineHook } from "eve/hooks";

import { TripStore } from "../../lib/trip-store.js";
import { ConversationLog } from "../../lib/conversation-log.js";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

export default defineHook({
  events: {
    async "message.completed"(event, ctx) {
      // Narration before a tool call, not the turn's terminal reply — skip.
      if (event.data.finishReason === "tool-calls") return;

      const text = event.data.message;
      if (!text) return;

      const caller = ctx.session.auth?.current ?? ctx.session.auth?.initiator ?? null;
      const chatId = caller?.attributes?.["chat_id"];
      if (typeof chatId !== "string") return;

      try {
        const store = new TripStore(dataRoot());
        const trip = await store.tripForChat(chatId);
        if (!trip) return;

        new ConversationLog(`${trip.dir}/chatlog`, trip.timezone).append({
          ts: Math.floor(Date.now() / 1000),
          from: "marcel",
          name: "Marcel",
          text,
          marcel: true,
        });
      } catch (err) {
        // A logging failure must never fail the turn — matches every other best-effort I/O
        // seam in this codebase (e.g. agent/channels/telegram.ts's onBotAddedToGroup).
        console.error("eve-marcel: failed to log Marcel's own reply —", err);
      }
    },
  },
});
